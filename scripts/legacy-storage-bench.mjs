// SPDX-License-Identifier: Apache-2.0
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { prepareBench, qualifyBenchReferences } from './lib/legacy-storage-bench.mjs';
import { privateJson } from './lib/legacy-storage-journal.mjs';
import { deploymentReader } from './lib/legacy-storage-reader.mjs';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
try {
  const { values: v } = parseArgs({
    options: {
      deployment: { type: 'string' },
      audit: { type: 'string' },
      candidate: { type: 'string' },
      out: { type: 'string' },
      scan: { type: 'string' },
      'body-coverage': { type: 'string' },
    },
  });
  if (
    !v.deployment?.startsWith('dev:') ||
    !v.audit ||
    !v.candidate ||
    !v.out ||
    resolve(v.out) === root ||
    resolve(v.out).startsWith(root + '/')
  )
    throw Error('BENCH_ARGUMENT_INVALID');
  const audit = JSON.parse(await readFile(v.audit)),
    candidate = JSON.parse(await readFile(v.candidate));
  if (audit.deployment !== v.deployment) throw Error('BENCH_DEPLOYMENT_CHANGED');
  let result = await prepareBench(
    audit,
    candidate,
    deploymentReader(v.deployment, root),
    root,
    resolve(v.out),
    p => console.error(JSON.stringify(p)),
  );
  if (v.scan || v['body-coverage']) {
    if (!v.scan || !v['body-coverage']) throw Error('BENCH_REFERENCE_PROOF_REQUIRED');
    result = qualifyBenchReferences(
      result,
      JSON.parse(await readFile(v.scan)),
      JSON.parse(await readFile(v['body-coverage'])),
    );
    await privateJson(resolve(v.out), result);
  }
  console.log(
    JSON.stringify({
      complete: result.complete,
      rows: result.totalRows,
      jsonBytes: result.jsonBytes,
      tables: result.tables.length,
      metrics: result.metrics,
      sha256: result.sha256,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      error: {
        code: /^(?:BENCH|CLEANUP)_[A-Z_]+$/.test(error.message ?? '')
          ? error.message
          : 'BENCH_PREPARATION_FAILED',
        message: 'Read-only ownership preparation stopped; no rows or files changed.',
      },
    }),
  );
  process.exitCode = 1;
}
