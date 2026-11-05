// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deploymentReader } from './lib/legacy-storage-reader.mjs';
import { privateJson } from './legacy-storage-audit.mjs';
import { parseVerification } from './legacy-storage-verify.mjs';
import { storageClass, digestHex } from './lib/legacy-storage-verify.mjs';
import { attributionPage, attributionFilter, attributionSummary } from './lib/legacy-storage-attribution.mjs';
import { costEstimate } from './lib/legacy-storage-report.mjs';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
export async function attribute(command, reader, progress = () => {}) {
  const raw = await readFile(command.audit),
    report = JSON.parse(raw);
  if (!report.coverage?.fullyPaged || report.deployment !== command.deployment)
    throw new Error('VERIFY_AUDIT_INVALID');
  const auditSha256 = createHash('sha256').update(raw).digest('hex');
  const files = report.files
    .filter(f => storageClass(f) === 4)
    .map(f => ({ ...f, digest: digestHex(f.sha256) }));
  const filter = attributionFilter(files),
    digests = new Set(files.map(f => f.digest));
  let state;
  try {
    state = JSON.parse(await readFile(command.out, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (state && !command.resume) throw new Error('VERIFY_USE_RESUME');
  if (
    command.resume &&
    (!state || state.auditSha256 !== auditSha256 || state.deployment !== command.deployment)
  )
    throw new Error('VERIFY_STATE_INVALID');
  state ??= {
    schema: 1,
    deployment: command.deployment,
    auditSha256,
    startedAt: new Date().toISOString(),
    tables: (await reader.tables()).sort(),
    tableIndex: 0,
    cursor: null,
    matches: [],
    history: {},
    metrics: { calls: 0, documents: 0, jsonBytes: 0, responseBytes: 0 },
    complete: false,
  };
  while (!state.complete && state.tableIndex < state.tables.length) {
    const table = state.tables[state.tableIndex];
    if (costEstimate({ ...state.metrics, jsonBytes: state.metrics.jsonBytes + 4_000_000 }) > 1)
      throw new Error('VERIFY_ESTIMATE_EXCEEDED');
    state.metrics.calls++;
    await privateJson(command.out, state);
    const page = await reader.page(
      `return await (${attributionPage.toString()})(ctx,${JSON.stringify(table)},${JSON.stringify(state.cursor)},${JSON.stringify(filter.prefixes)},${JSON.stringify(filter.hours)});`,
    );
    if (!Array.isArray(page.matches) || (!page.isDone && (!page.cursor || page.cursor === state.cursor)))
      throw new Error('VERIFY_PAGE_INVALID');
    state.metrics.documents += page.documents;
    state.metrics.jsonBytes += page.jsonBytes;
    state.metrics.responseBytes += Buffer.byteLength(JSON.stringify(page));
    state.matches.push(...page.matches.filter(m => digests.has(m.sha256)));
    for (const [key, count] of Object.entries(page.history)) {
      const k = JSON.stringify([table, ...JSON.parse(key)]);
      state.history[k] = (state.history[k] ?? 0) + count;
    }
    state.cursor = page.isDone ? null : page.cursor;
    if (page.isDone) state.tableIndex++;
    await privateJson(command.out, state);
    if (state.metrics.calls % 25 === 0)
      progress({ table, completedTables: state.tableIndex, ...state.metrics });
  }
  if (!state.complete) {
    const tables = (await reader.tables()).sort();
    if (JSON.stringify(tables) !== JSON.stringify(state.tables)) throw new Error('VERIFY_TABLES_CHANGED');
    state.complete = true;
    state.finishedAt = new Date().toISOString();
    state.summary = attributionSummary(files, state.matches);
    await privateJson(command.out, state);
  }
  return state;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const c = parseVerification(process.argv.slice(2));
    const state = await attribute(c, deploymentReader(c.deployment, root), p =>
      console.error(JSON.stringify(p)),
    );
    console.log(JSON.stringify({ complete: state.complete, summary: state.summary, metrics: state.metrics }));
  } catch (error) {
    console.error(
      JSON.stringify({
        error: {
          code: /^VERIFY_[A-Z_]+$/.test(error.message ?? '') ? error.message : 'VERIFY_READ_FAILED',
          message: 'Read-only attribution stopped; private progress retained. No files changed.',
        },
      }),
    );
    process.exitCode = 1;
  }
}
