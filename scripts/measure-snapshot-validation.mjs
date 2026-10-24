// SPDX-License-Identifier: Apache-2.0
// Isolated retained-source validation, not full reconciliation or lock timing.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const retainedRoots = data => [
  ...new Set([
    ...data.intents.map(item => item.base),
    ...(data.hostedChannelMoves ?? []).map(item => item.head),
  ]),
];

/** Reference loop retained from native-companion before scoped closure reuse. */
export function originalValidation(source, roots) {
  const conflicts = [];
  for (const head of roots) {
    try {
      for (const state of source.ancestors(head)) {
        const original = source.state(state);
        for (const file of original.files) source.object(file.blob);
        if (original.git) source.object(original.git.bundle);
      }
    } catch (error) {
      if (error?.name !== 'ForgeError') throw error;
      conflicts.push({ collection: 'source', field: 'retainedState', hosted: head });
    }
  }
  return conflicts;
}

export function countValidation(source, run) {
  const original = { object: source.object, state: source.state },
    objects = new Map(),
    states = new Map();
  let objectCalls = 0,
    stateCalls = 0,
    objectBytes = 0,
    failedObjects = 0,
    failedStates = 0;
  source.object = function (id) {
    objectCalls++;
    try {
      const bytes = original.object.call(this, id);
      objectBytes += bytes.length;
      const row = objects.get(id) ?? { id, calls: 0, bytes: bytes.length };
      row.calls++;
      objects.set(id, row);
      return bytes;
    } catch (error) {
      failedObjects++;
      throw error;
    }
  };
  source.state = function (id) {
    stateCalls++;
    try {
      const value = original.state.call(this, id);
      states.set(id, (states.get(id) ?? 0) + 1);
      return value;
    } catch (error) {
      failedStates++;
      throw error;
    }
  };
  const started = performance.now(),
    cpu = process.cpuUsage();
  try {
    const conflicts = run(source);
    return {
      durationMs: performance.now() - started,
      cpu: process.cpuUsage(cpu),
      conflicts,
      objectCalls,
      objectBytes,
      stateCalls,
      failedObjects,
      failedStates,
      distinctObjects: objects.size,
      distinctObjectBytes: [...objects.values()].reduce((sum, row) => sum + row.bytes, 0),
      distinctStates: states.size,
      objects: [...objects.values()],
      states: [...states].map(([id, calls]) => ({ id, calls })),
    };
  } finally {
    source.object = original.object;
    source.state = original.state;
  }
}

async function main() {
  const [requestPath, outputPath] = process.argv.slice(2);
  if (!requestPath || !outputPath)
    throw new Error('Usage: node scripts/measure-snapshot-validation.mjs REQUEST_JSON NEW_RESULT_JSON');
  if (existsSync(outputPath))
    throw new Error('Preserve the original measurement; choose a new receipt deliberately.');
  const request = JSON.parse(readFileSync(requestPath, 'utf8')),
    bytes = readFileSync(request.snapshotPath),
    data = JSON.parse(bytes);
  if (sha(bytes) !== request.snapshotSha256) throw new Error('Retained snapshot pin changed.');
  const { NativeSource } = await import(pathToFileURL(join(request.runtime, 'dist/native-source.js')));
  const pointer = join(request.root, '.forge/work/work.json'),
    before = sha(readFileSync(pointer)),
    roots = retainedRoots(data);
  const receipt = {
    status: 'started',
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    request,
    revision: data.revision,
    roots,
    scope:
      'One isolated source-validation invocation on retained pins. No canonical lock, Work write, provider operation, merge or full recovery. OS cache is uncontrolled; method counters add overhead. This is not end-to-end product latency.',
  };
  const save = () => {
    writeFileSync(`${outputPath}.tmp`, JSON.stringify(receipt, null, 2), { mode: 0o600 });
    renameSync(`${outputPath}.tmp`, outputPath);
  };
  save();
  try {
    let validate = source => originalValidation(source, roots);
    if (request.mode === 'scoped') {
      const { NativeClosureValidation } = await import(
        pathToFileURL(join(request.runtime, 'dist/native-closure-validation.js'))
      );
      validate = source => {
        const closure = new NativeClosureValidation(source),
          conflicts = [];
        for (const head of roots)
          try {
            closure.validate(head);
          } catch (error) {
            if (error?.name !== 'ForgeError') throw error;
            conflicts.push({ collection: 'source', field: 'retainedState', hosted: head });
          }
        return conflicts;
      };
    } else if (request.mode !== 'original') throw new Error('Select original or scoped validation mode.');
    receipt.measurement = countValidation(new NativeSource(request.root), validate);
    receipt.canonicalPointerUnchanged = before === sha(readFileSync(pointer));
    if (!receipt.canonicalPointerUnchanged)
      throw new Error('Canonical Work changed concurrently; retain the result with this qualification.');
    receipt.status = 'passed';
  } catch (error) {
    receipt.status = 'failed';
    receipt.error = { name: error?.name, code: error?.code };
    throw error;
  } finally {
    save();
  }
  const { objects, states, ...summary } = receipt.measurement;
  console.log(
    JSON.stringify({
      outputPath,
      status: receipt.status,
      revision: data.revision,
      rootCount: roots.length,
      ...summary,
    }),
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => {
    console.error(
      JSON.stringify({
        error: error?.code ?? error?.name,
        message: 'Validation measurement failed; retain its original request and receipt.',
      }),
    );
    process.exitCode = 1;
  });
