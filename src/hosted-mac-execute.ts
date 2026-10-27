import { semanticCheckCommand } from './semantic-check-command.js';
import { ContractTimingReader } from './contract-test-timings.js';
import { semanticTests } from './intent-semantic-conflict.js';
import { localMacLogFiles } from './check-local-log-files.js';
import { compactProviderOutput } from './check-compact-output.js';
// SPDX-License-Identifier: Apache-2.0
import { deliverMacCallback } from './hosted-mac-delivery.js';
import { createReadStream } from 'node:fs';
import { captureArtifacts } from './work-artifacts.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { HostedCheckoutCache, type CheckoutObjectTransport } from './hosted-checkout-cache.js';
import { parseNativeState } from './native-state-format.js';
import { installHostedFile } from './hosted-checkout-files.js';
import { checkEnvironment, checkProcessEnvironment, checkPassthrough } from './check-environment.js';
import { checkPin, type HostedCheckRun } from './hosted-check.js';
import { signHostedCheckCallback, type HostedCheckCallback } from './hosted-check-evidence.js';
import { hostedOutputPublisher, type OutputTransport } from './hosted-output-transfer.js';
import { collectHostedOutput } from './hosted-output-collector.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { digest } from './hash.js';
import { HostedMacProvider } from './hosted-mac-worker.js';
import { invariant } from './errors.js';
import type { OutputRoot } from './hosted-check-output.js';

export type MacExecutionTransport = CheckoutObjectTransport & {
  upload(pin: { sha256: string; size: number }, bytes: Buffer): Promise<unknown>;
  callback(value: HostedCheckCallback, signature: string): Promise<HostedCheckRun>;
  output: OutputTransport;
};
/** Check commands receive a private HOME/temp and only declared inputs. Source
 * bytes go from hosted/R2 to a hash-verified checkout, without any Git export. */
export async function executeHostedMacCheck(
  initial: HostedCheckRun,
  signal: AbortSignal,
  control: (command: unknown) => Promise<HostedCheckRun>,
  transport: MacExecutionTransport,
  key: string,
) {
  let run = initial;
  const localLogs = localMacLogFiles(initial.projectId, initial.id);
  const root = await mkdtemp(join(tmpdir(), 'forge-mac-check-'));
  let cleanup = false;
  const owner = run.lease!.owner,
    token = run.lease!.token;
  const save = async (command: Record<string, unknown>) => {
    signal.throwIfAborted();
    run = await control({ ...command, owner, token });
    return run;
  };
  try {
    const environment = checkEnvironment();
    invariant(
      environment.fingerprint === run.request.expectedEnvironment,
      'EVIDENCE_CHANGED',
      'The configured Mac environment changed.',
    );
    const cache = new HostedCheckoutCache(join(root, 'cache'), transport);
    await cache.ensure([run.request.expectedHead]);
    signal.throwIfAborted();
    const state = parseNativeState(await readFile(join(cache.objects, run.request.expectedHead)));
    const lockfile = state.files.find(file => file.path === 'package-lock.json')?.blob ?? digest('');
    const publish = async (value: unknown) => {
      const bytes = Buffer.from(canonicalPayload(value)),
        pin = { sha256: digest(bytes), size: bytes.length };
      await transport.upload(pin, bytes);
      signal.throwIfAborted();
      return pin;
    };
    const command = semanticCheckCommand(
      [run.check.executable, ...run.check.args],
      run.semanticPlan,
      process.execPath,
    );
    const selection = await publish({
      scope: 'full',
      tests: [],
      semanticTests: semanticTests(run.semanticPlan),
    });
    const manifest = await publish({
      head: run.request.expectedHead,
      definition: run.check.definition,
      command,
      lockfile,
      selection,
    });
    await save({
      kind: 'prepare',
      plan: {
        head: run.request.expectedHead,
        definition: run.check.definition,
        runtime: run.configuration.runtime,
        environmentFingerprint: environment.fingerprint,
        lockfile,
        selection,
        manifest,
        shardCount: 1,
      },
    });
    await cache.ensure(state.files.map(file => file.blob));
    signal.throwIfAborted();
    const checkout = join(root, 'source');
    await mkdir(checkout, { mode: 0o700 });
    for (const file of state.files) {
      signal.throwIfAborted();
      installHostedFile(checkout, cache.objects, file);
    }
    await save({ kind: 'reserve' });
    const executionId = `mac:${run.id}:${run.fence}:${owner}`;
    await save({ kind: 'observe', result: { status: 'accepted', executionId } });
    const provider = new HostedMacProvider(
      run,
      async () => {
        invariant(
          !checkPassthrough(run.check).some(
            name => name === 'FORGE_AUTH_TOKEN' || name.startsWith('FORGE_HOSTED_CHECK_KEY_'),
          ),
          'EVIDENCE_CHANGED',
          'Collector credentials cannot be project command inputs.',
        );
        const runtime = checkProcessEnvironment(run.check, environment, root);
        runtime.prepare();
        const secrets = [
          key,
          process.env.FORGE_AUTH_TOKEN ?? '',
          ...(run.check.credentials ?? []).map(name => process.env[name] ?? ''),
        ];
        const output = transport.output;
        const publisher = hostedOutputPublisher(run, key, {
          ...(output.prepareBatch && output.commitBatch
            ? {
                prepareBatch: (entries: Parameters<NonNullable<OutputTransport['prepareBatch']>>[0]) =>
                  deliverMacCallback(() => output.prepareBatch!(entries)),
                commitBatch: (entries: Parameters<NonNullable<OutputTransport['commitBatch']>>[0]) =>
                  deliverMacCallback(() => output.commitBatch!(entries)),
              }
            : {}),
          prepare: (message, signature) => deliverMacCallback(() => output.prepare(message, signature)),
          commit: (message, signature) => deliverMacCallback(() => output.commit(message, signature)),
          put: (url, headers, bytes) => deliverMacCallback(() => output.put(url, headers, bytes)),
        });
        await mkdir(join(root, 'spool'), { mode: 0o700 });
        let outputRoot: OutputRoot | undefined;
        const baseSink = publisher.sink(async (chunk, bytes) => {
          await writeFile(join(root, 'spool', `${chunk.object.sha256}.bytes`), bytes, { mode: 0o600 });
          await writeFile(join(root, 'spool', `${checkPin(chunk)}.json`), canonicalPayload(chunk), {
            mode: 0o600,
          });
        });
        const sink = {
          ...baseSink,
          ...(baseSink.publishBatch
            ? {
                publishBatch: async (...args: Parameters<NonNullable<typeof baseSink.publishBatch>>) => {
                  const receipts = (await publisher.publishBatch(...args)) as { root?: OutputRoot }[];
                  for (const reply of receipts)
                    if (reply.root && (!outputRoot || reply.root.revision > outputRoot.revision))
                      outputRoot = reply.root;
                },
              }
            : {}),
          seal: async (seal: Parameters<typeof baseSink.seal>[0]) => {
            // The commit reply supplies the authoritative combined output root.
            const { outputMessage, signOutput } = await import('./hosted-check-output.js');
            const message = outputMessage(run, { kind: 'seal', seal });
            const reply = (await deliverMacCallback(() =>
              transport.output.commit(message, signOutput(message, key)),
            )) as {
              root: OutputRoot;
            };
            if (!outputRoot || reply.root.revision > outputRoot.revision) outputRoot = reply.root;
          },
        };
        const reports: ContractTimingReader['reports'] = {};
        const child = spawn(command[0]!, command.slice(1), {
          cwd: checkout,
          env: runtime.env,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let killed = false;
        const kill = () => {
          if (killed) return;
          killed = true;
          try {
            if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
            else child.kill('SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
        };
        const exit = new Promise<number | null>((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', code => resolve(code));
        });
        signal.addEventListener('abort', kill, { once: true });
        if (signal.aborted) kill();
        try {
          const observe = async function* (stream: AsyncIterable<Uint8Array>) {
            const contractReader = new ContractTimingReader();
            const decoder = new TextDecoder();
            for await (const bytes of stream) {
              contractReader.accept(decoder.decode(bytes, { stream: true }));
              yield bytes;
            }
            contractReader.accept(decoder.decode());
            Object.assign(reports, contractReader.reports);
          };
          const stream = (name: 'stdout' | 'stderr') => {
            let summary = '';
            return collectHostedOutput(
              run.checkLogs?.uploadLocal
                ? observe(localLogs.stream(child[name]!, name))
                : compactProviderOutput(observe(localLogs.stream(child[name]!, name)), value => {
                    summary = value;
                  }),
              {
                shard: 0,
                attempt: run.fence,
                executionId,
                stream: name,
                name,
                kind: run.checkLogs?.uploadLocal ? 'local-log' : 'summary',
                ...(run.checkLogs?.uploadLocal
                  ? { expiresAt: Date.parse(run.at) + run.checkLogs.retentionDays * 86400000 }
                  : {}),
              },
              { secrets, paths: [root, homedir()] },
              sink,
              64 * 1024,
              true,
              () => summary,
            );
          };
          const [exitCode] = await Promise.all([exit, stream('stdout'), stream('stderr')]);
          signal.throwIfAborted();
          for (const artifact of await captureArtifacts(checkout, root, run.check.artifactPaths ?? [])) {
            if (artifact.status !== 'retained') continue;
            await collectHostedOutput(
              createReadStream(join(root, 'artifacts', artifact.filename)),
              {
                shard: 0,
                attempt: run.fence,
                executionId,
                stream: 'artifact',
                name: artifact.sourcePath,
              },
              { secrets, paths: [root, homedir()] },
              sink,
            );
          }
          const callback = async (result: HostedCheckCallback['result']) => {
            const value: HostedCheckCallback = {
              schema: 1,
              eventId: randomUUID(),
              projectId: run.projectId,
              runId: run.id,
              operationId: run.request.operationId,
              authorityEpoch: run.request.authorityEpoch,
              fence: run.fence,
              provider: 'mac',
              executionId,
              head: run.request.expectedHead,
              definition: run.check.definition,
              configuration: run.request.expectedConfiguration,
              environmentFingerprint: environment.fingerprint,
              runtime: run.configuration.runtime,
              planDigest: run.planDigest!,
              lockfile,
              selection,
              result,
            };
            run = await deliverMacCallback(() =>
              transport.callback(value, signHostedCheckCallback(value, key)),
            );
          };
          const status = exitCode === 0 ? 'passed' : exitCode === null ? 'interrupted' : 'failed';
          await callback({
            kind: 'shard',
            shard: { index: 0, attempt: run.fence, executionId, status, exitCode, output: null },
          });
          await callback({
            kind: 'complete',
            status,
            exitCode,
            output: null,
            cost: { status: 'unknown' },
            contractReports: reports,
          });
          if (outputRoot) await publisher.final(outputRoot);
        } finally {
          localLogs.complete();
          signal.removeEventListener('abort', kill);
          kill();
        }
      },
      signal,
    );
    await provider.dispatch(run);
    cleanup = true;
  } catch (error) {
    // Cancellation/ownership loss has already fenced this attempt. Preserve the
    // spool on unknown transfer failures, even after terminal evidence commits.
    const failure = error as { name?: string; code?: string; data?: { code?: string } };
    const code = failure.code ?? failure.data?.code;
    if (
      signal.aborted &&
      (failure.name === 'AbortError' || code === 'WORK_STALE' || code === 'EVIDENCE_CHANGED')
    )
      cleanup = true;
    else throw error;
  } finally {
    if (cleanup) await rm(root, { recursive: true, force: true });
  }
}
