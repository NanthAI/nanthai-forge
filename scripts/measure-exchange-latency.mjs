// SPDX-License-Identifier: Apache-2.0
// Explicit qualification harness; it never creates a project, changes a Channel or
// returns hosted source. A push publishes only the request's checkpoint. Recovery
// uses a fresh target and the real supplied journal, never a manufactured journal.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { getFunctionName } from 'convex/server';

export function summarizeTrace(trace) {
  const groups = new Map();
  for (const row of trace.rpc) {
    const key = `${row.method}:${row.name}`,
      group = groups.get(key) ?? {
        method: row.method,
        name: row.name,
        count: 0,
        totalMs: 0,
        minMs: Infinity,
        maxMs: 0,
        pins: 0,
        failedOrUnknown: 0,
      };
    group.count++;
    group.totalMs += row.durationMs ?? 0;
    group.minMs = Math.min(group.minMs, row.durationMs ?? 0);
    group.maxMs = Math.max(group.maxMs, row.durationMs ?? 0);
    group.pins += row.pins ?? 0;
    if (row.status !== 'ok') group.failedOrUnknown++;
    groups.set(key, group);
  }
  const intervals = trace.rpc
    .filter(row => row.durationMs !== undefined)
    .map(row => [row.startMs, row.startMs + row.durationMs])
    .sort((a, b) => a[0] - b[0]);
  let rpcUnionMs = 0,
    end = -Infinity;
  for (const [start, stop] of intervals) {
    rpcUnionMs += Math.max(0, stop - Math.max(start, end));
    end = Math.max(end, stop);
  }
  return {
    rpc: [...groups.values()],
    rpcCalls: trace.rpc.length,
    rpcUnionMs,
    objectPostAttempts: trace.http.filter(row => row.kind === 'object-post').length,
    actualObjectPostBodyBytes: trace.http
      .filter(row => row.kind === 'object-post')
      .reduce((sum, row) => sum + row.requestBodyBytes, 0),
  };
}

/** Public RPC spans only. Authorization headers, URLs and payloads are never logged. */
export async function traceExchange(client, run, options = {}) {
  const started = performance.now(),
    trace = {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      status: 'started',
      phases: [],
      rpc: [],
      http: [],
    };
  const persist = () => options.onProgress?.(structuredClone(trace));
  const now = () => performance.now() - started,
    methods = {},
    nativeFetch = globalThis.fetch;
  const phase = async (name, fn) => {
    const row = { name, startMs: now(), status: 'started' };
    trace.phases.push(row);
    persist();
    try {
      const result = await fn();
      row.status = 'ok';
      return result;
    } catch (error) {
      row.status = 'failed-or-unknown';
      row.errorCode = error?.data?.code ?? error?.code ?? error?.name ?? 'Error';
      throw error;
    } finally {
      row.durationMs = now() - row.startMs;
      persist();
    }
  };
  for (const method of ['query', 'mutation', 'action']) {
    methods[method] = client[method];
    client[method] = async (fn, args, ...rest) => {
      const row = {
        method,
        name: getFunctionName(fn),
        startMs: now(),
        status: 'started',
        pins: args?.objects?.length ?? args?.digests?.length ?? null,
      };
      trace.rpc.push(row);
      persist();
      try {
        const result = await methods[method].call(client, fn, args, ...rest);
        row.status = 'ok';
        if (Array.isArray(result)) row.resultItems = result.length;
        return result;
      } catch (error) {
        row.status = 'failed-or-unknown';
        row.errorCode = error?.data?.code ?? error?.code ?? error?.name ?? 'Error';
        throw error;
      } finally {
        row.durationMs = now() - row.startMs;
        persist();
      }
    };
  }
  globalThis.fetch = async (input, init) => {
    const contentType = new Headers(init?.headers).get('Content-Type') ?? '';
    const body = init?.body,
      requestBodyBytes =
        typeof body === 'string'
          ? Buffer.byteLength(body)
          : ArrayBuffer.isView(body)
            ? body.byteLength
            : body instanceof ArrayBuffer
              ? body.byteLength
              : 0;
    const row = {
      kind: contentType.startsWith('application/x-forge-object-') ? 'object-post' : 'rpc-http',
      startMs: now(),
      requestBodyBytes,
      status: 'started',
    };
    trace.http.push(row);
    persist();
    try {
      const response = await nativeFetch(input, init);
      row.status = `http-${response.status}`;
      return response;
    } catch (error) {
      row.status = 'failed-or-unknown';
      throw error;
    } finally {
      row.durationMs = now() - row.startMs;
      persist();
    }
  };
  try {
    trace.result = await run(phase);
    trace.status = 'passed';
    return trace;
  } catch (error) {
    trace.status = 'failed-or-unknown';
    trace.errorCode = error?.data?.code ?? error?.code ?? error?.name ?? 'Error';
    throw error;
  } finally {
    for (const method of Object.keys(methods)) client[method] = methods[method];
    globalThis.fetch = nativeFetch;
    trace.durationMs = now();
    trace.summary = summarizeTrace(trace);
    trace.limitations =
      'Public RPC time includes network and server action work; no internal server phase latency is inferred. RPC union accounts for overlap; summed durations are not elapsed time. HTTP spans end at response headers. Object POST body bytes are attempted bytes, not proof of provider receipt; unknown replies require original-operation reconciliation. Headers/TLS are excluded. Private ledger writes add instrumentation overhead. Single samples are observations, not causal speedup or latency guarantees.';
    persist();
  }
}

export async function measureRequest({ request, transport, runtime, onProgress }) {
  const { prepareNativeExchange, pushNativeExchange, pullNativeExchange } = await import(
    pathToFileURL(join(runtime, 'dist/native-exchange.js'))
  );
  const { WorkStore } = await import(pathToFileURL(join(runtime, 'dist/work-store.js')));
  return traceExchange(
    transport.client,
    async phase => {
      if (request.action === 'push') {
        const store = new WorkStore(request.root);
        const prepared = await phase('prepare', () =>
          prepareNativeExchange(store, request.revision, request.operationId, true),
        );
        const result = await phase('push', () =>
          pushNativeExchange(store, request.revision, request.operationId, transport),
        );
        return { ...result, preparedDirectory: prepared.directory };
      }
      if (request.action === 'metadata') {
        const manifest = await phase('remote-metadata', () => transport.manifest(request.backupId));
        return {
          digest: manifest.digest,
          sourceDigest: manifest.sourceDigest,
          bytes: Buffer.byteLength(manifest.json),
        };
      }
      if (request.action === 'recover')
        return phase('recover', () =>
          pullNativeExchange(request.backupId, request.target, transport, {
            ...(request.cacheRoot ? { cacheRoot: request.cacheRoot } : {}),
            ...(request.journalPath ? { journalPath: request.journalPath } : {}),
          }),
        );
      throw new Error('Select push, metadata or recover in the explicit measurement request.');
    },
    { onProgress },
  );
}

async function main() {
  const [requestPath, outputPath] = process.argv.slice(2);
  if (!requestPath || !outputPath || process.argv.includes('--help')) {
    console.log(
      'Usage: node scripts/measure-exchange-latency.mjs REQUEST_JSON RESULT_JSON\nSet FORGE_AUTH_TOKEN to an existing account JWT; do not put credentials in requests.\nRequest: {action:"push",url,projectId,root,revision,operationId,previous:null}, {action:"metadata",url,projectId,backupId}, or {action:"recover",url,projectId,backupId,target,cacheRoot?,journalPath?}.\nOptional FORGE_MEASURE_RUNTIME selects an installed package root. This harness executes the explicit request once and retains unknown outcomes; it does not retry, create projects, return source or clean restored owners.',
    );
    return;
  }
  const request = JSON.parse(readFileSync(requestPath, 'utf8')),
    runtime = resolve(
      process.env.FORGE_MEASURE_RUNTIME ?? join(dirname(fileURLToPath(import.meta.url)), '..'),
    );
  const { ConvexExchange } = await import(pathToFileURL(join(runtime, 'dist/exchange-client.js')));
  const transport = new ConvexExchange(
    request.url,
    process.env.FORGE_AUTH_TOKEN,
    request.projectId,
    request.operationId ?? '',
    request.previous ?? null,
  );
  const output = resolve(outputPath),
    identity = {
      action: request.action,
      operationId: request.operationId,
      revision: request.revision,
      backupId: request.backupId,
      runtime,
    };
  const persist = trace => {
    writeFileSync(`${output}.tmp`, JSON.stringify({ ...identity, ...trace }, null, 2), { mode: 0o600 });
    renameSync(`${output}.tmp`, output);
  };
  const trace = await measureRequest({ request, transport, runtime, onProgress: persist });
  console.log(
    JSON.stringify({
      resultPath: output,
      status: trace.status,
      durationMs: trace.durationMs,
      summary: trace.summary,
    }),
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => {
    console.error(
      JSON.stringify({
        error: {
          code: error?.code ?? error?.name ?? 'Error',
          message:
            'Measurement failed or outcome is unknown; inspect the private receipt and retain the original request.',
        },
      }),
    );
    process.exitCode = 1;
  });
