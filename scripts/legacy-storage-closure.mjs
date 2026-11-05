// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { deploymentReader } from './lib/legacy-storage-reader.mjs';
import { frozenScan } from './lib/legacy-storage-cleanup.mjs';
import { closeBodies } from './lib/legacy-storage-closure.mjs';
const { values: v } = parseArgs({
  options: {
    deployment: { type: 'string' },
    audit: { type: 'string' },
    scan: { type: 'string' },
    out: { type: 'string' },
  },
});
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
try {
  if (
    !v.deployment?.startsWith('dev:') ||
    !v.audit ||
    !v.out ||
    resolve(v.out) === root ||
    resolve(v.out).startsWith(root + '/')
  )
    throw new Error('CLOSURE_ARGUMENT_INVALID');
  const audit = JSON.parse(await readFile(v.audit));
  if (audit.deployment !== v.deployment) throw new Error('CLOSURE_DEPLOYMENT_CHANGED');
  const reader = deploymentReader(v.deployment, root);
  const scan = v.scan
    ? JSON.parse(await readFile(v.scan))
    : await frozenScan(
        reader,
        'read-only-preparation',
        resolve(v.out) + '.scan',
        [...new Set(audit.files.map(f => f.storageId.length))],
        p => console.error(JSON.stringify(p)),
      );
  const proof = await closeBodies(audit, scan, reader, await reader.r2Config(), resolve(v.out), {
    progress: p => console.error(JSON.stringify(p)),
  });
  console.log(
    JSON.stringify({
      complete: proof.complete,
      roots: proof.roots,
      references: proof.references.length,
      failures: proof.failures.length,
      metrics: proof.metrics,
    }),
  );
  if (!proof.complete) process.exitCode = 1;
} catch (error) {
  console.error(
    JSON.stringify({
      error: {
        code: /^CLOSURE_[A-Z_]+$/.test(error.message ?? '') ? error.message : 'CLOSURE_READ_FAILED',
        message: 'Read-only body coverage stopped; no mutation or deletion occurred.',
      },
    }),
  );
  process.exitCode = 1;
}
