// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { pageSource } from './lib/legacy-storage-query.mjs';
import { classifyStorage, costEstimate } from './lib/legacy-storage-report.mjs';
import { deploymentReader, listR2 } from './lib/legacy-storage-reader.mjs';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

export function parseAudit(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      deployment: { type: 'string' },
      out: { type: 'string' },
      resume: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      'with-r2-list': { type: 'boolean' },
    },
  });
  if (
    !['inventory', 'plan'].includes(positionals[0]) ||
    positionals.length !== 1 ||
    !values.out ||
    (positionals[0] === 'inventory' && !values.deployment?.startsWith('dev:')) ||
    (positionals[0] === 'plan' && (values.deployment || values.resume || values['with-r2-list']))
  )
    throw new Error('AUDIT_ARGUMENT_INVALID');
  const out = resolve(values.out);
  if (out === root || out.startsWith(root + '/')) throw new Error('AUDIT_PRIVATE_OUTPUT_REQUIRED');
  return {
    operation: positionals[0],
    deployment: values.deployment,
    out,
    resume: !!values.resume,
    withR2: !!values['with-r2-list'],
  };
}
export async function privateJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
  await rename(tmp, path);
}
export async function audit(command, reader, options = {}) {
  const statePath = command.out + '.state.json';
  const state = command.resume
    ? JSON.parse(await readFile(statePath, 'utf8'))
    : {
        schema: 1,
        deployment: command.deployment,
        withR2: command.withR2,
        startedAt: new Date().toISOString(),
        tableIndex: 0,
        cursor: null,
        tables: null,
        counts: {},
        projects: [],
        storage: [],
        references: [],
        metrics: { calls: 0, documents: 0, jsonBytes: 0, responseBytes: 0 },
        complete: false,
      };
  if (
    state.schema !== 1 ||
    state.deployment !== command.deployment ||
    state.withR2 !== command.withR2 ||
    state.complete
  )
    throw new Error('AUDIT_STATE_INVALID');
  if (!command.resume) {
    // Refuse to overwrite a previous pass accidentally.
    try {
      await readFile(statePath);
      throw new Error('AUDIT_USE_RESUME_OR_NEW_OUTPUT');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  state.tables ??= [...new Set(['_storage', ...(await reader.tables())])].sort();
  await privateJson(statePath, state);
  while (state.tableIndex < state.tables.length) {
    if (
      state.metrics.calls >= 50_000 ||
      costEstimate({
        ...state.metrics,
        calls: state.metrics.calls + 1,
        jsonBytes: state.metrics.jsonBytes + 4_000_000,
        responseBytes: state.metrics.responseBytes + 8_000_000,
      }) > 1
    )
      throw new Error('AUDIT_ESTIMATE_EXCEEDED');
    const table = state.tables[state.tableIndex];
    state.metrics.calls++;
    await privateJson(statePath, state);
    const page = await reader.page(
      pageSource(table, state.cursor, 1024, [...new Set(state.storage.map(file => file._id.length))]),
    );
    if (
      !Array.isArray(page.references) ||
      !Number.isSafeInteger(page.documents) ||
      typeof page.isDone !== 'boolean' ||
      (!page.isDone && (typeof page.cursor !== 'string' || page.cursor === state.cursor))
    )
      throw new Error('AUDIT_PAGE_INVALID');
    const count = (state.counts[table] ??= { documents: 0, jsonBytes: 0, pages: 0, projects: {} });
    count.documents += page.documents;
    count.jsonBytes += page.jsonBytes;
    count.pages++;
    for (const [key, value] of Object.entries(page.groups)) {
      const group = (count.projects[key] ??= { documents: 0, jsonBytes: 0 });
      group.documents += value.documents;
      group.jsonBytes += value.jsonBytes;
    }
    state.metrics.documents += page.documents;
    state.metrics.jsonBytes += page.jsonBytes;
    state.metrics.responseBytes += Buffer.byteLength(JSON.stringify(page));
    state.references.push(...page.references);
    state.storage.push(...page.storage);
    state.projects.push(...page.projects);
    state.cursor = page.isDone ? null : page.cursor;
    if (page.isDone) state.tableIndex++;
    await privateJson(statePath, state);
    options.progress?.({
      table,
      completedTables: state.tableIndex,
      totalTables: state.tables.length,
      ...state.metrics,
    });
  }
  let r2;
  if (command.withR2) {
    const pins = new Set();
    const digests = new Set(
      state.storage.map(file =>
        /^[a-f0-9]{64}$/.test(file.sha256 ?? '')
          ? file.sha256
          : Buffer.from(file.sha256 ?? '', 'base64').toString('hex'),
      ),
    );
    for (const ref of state.references) {
      if (ref.r2Key) pins.add(ref.r2Key);
      if (/^[a-f0-9]{64}$/.test(ref.digest ?? '')) pins.add(`v1/p/${ref.project}/o/${ref.digest}`);
    }
    r2 = new Map();
    state.r2 = await (options.listR2 ?? listR2)(
      await reader.r2Config(),
      (key, size) => {
        if (pins.has(key) || digests.has(key.split('/').at(-1))) r2.set(key, size);
      },
      undefined,
      Math.max(0, 1 - costEstimate(state.metrics)),
    );
    state.r2Matches = [...r2];
    await privateJson(statePath, state);
  }
  const report = {
    schema: 1,
    dryRun: true,
    deployment: state.deployment,
    startedAt: state.startedAt,
    finishedAt: new Date().toISOString(),
    coverage: {
      allTables: state.tables,
      fullyPaged: true,
      concurrentSnapshot: false,
      r2: command.withR2 ? 'key-and-size-list' : 'unverified',
    },
    tables: state.counts,
    projects: state.projects,
    metrics: {
      ...state.metrics,
      r2: state.r2 ?? null,
      estimatedMarginalDollars: costEstimate({ ...state.metrics, r2Lists: state.r2?.pages ?? 0 }),
      billedDollars: null,
      databaseBytesBasis: 'serialized JSON; excludes binary/index overhead',
    },
    ...classifyStorage(state.storage, state.references, r2),
  };
  await privateJson(command.out, report);
  state.complete = true;
  await privateJson(statePath, state);
  return report;
}
export async function plan(path) {
  const report = JSON.parse(await readFile(path, 'utf8'));
  if (report.schema !== 1 || report.dryRun !== true || !report.coverage?.fullyPaged)
    throw new Error('AUDIT_INCOMPLETE');
  return {
    dryRun: true,
    writes: 0,
    deployment: report.deployment,
    observedAt: report.finishedAt,
    classes: report.classes,
    prerequisites: [
      'Owner approves exact current file list',
      'Current full-digest R2 verification',
      'Fresh qualifying file-inclusive backup',
      'Recheck references and source/runtime pins before each approved page',
    ],
    rollback:
      'Restore the qualifying file-inclusive backup retained with this audit to an approved fresh target with matching code/configuration and retained R2 objects; no automatic undo.',
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const command = parseAudit(process.argv.slice(2));
    const result =
      command.operation === 'plan'
        ? await plan(command.out)
        : await audit(command, deploymentReader(command.deployment, root), {
            progress: p => {
              if (p.calls % 25 === 0) console.error(JSON.stringify({ progress: p }));
            },
          });
    console.log(
      JSON.stringify(
        command.operation === 'plan'
          ? result
          : { dryRun: true, total: result.total, classes: result.classes, metrics: result.metrics },
      ),
    );
  } catch (error) {
    const code = /^(?:AUDIT_|R2_)[A-Z_]+$/.test(error.message ?? '') ? error.message : 'AUDIT_READ_FAILED';
    console.error(
      JSON.stringify({
        error: {
          code,
          message: 'Read-only audit stopped. Private state is retained; no migration or deletion occurred.',
        },
      }),
    );
    process.exitCode = 1;
  }
}
