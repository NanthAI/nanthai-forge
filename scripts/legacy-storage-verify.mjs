// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { deploymentReader } from './lib/legacy-storage-reader.mjs';
import { privateJson } from './legacy-storage-audit.mjs';
import {
  storageClass,
  verifyFile,
  metadataSource,
  verificationIo,
  verificationSummary,
} from './lib/legacy-storage-verify.mjs';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
export function parseVerification(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      deployment: { type: 'string' },
      audit: { type: 'string' },
      out: { type: 'string' },
      resume: { type: 'boolean' },
    },
  });
  if (positionals.length || !values.deployment?.startsWith('dev:') || !values.audit || !values.out)
    throw new Error('VERIFY_ARGUMENT_INVALID');
  const out = resolve(values.out);
  if (out === root || out.startsWith(root + '/')) throw new Error('VERIFY_PRIVATE_OUTPUT_REQUIRED');
  return { deployment: values.deployment, audit: resolve(values.audit), out, resume: !!values.resume };
}
export async function verify(command, reader, options = {}) {
  const bytes = await readFile(command.audit),
    report = JSON.parse(bytes);
  const auditSha256 = createHash('sha256').update(bytes).digest('hex');
  if (
    !report.coverage?.fullyPaged ||
    report.coverage.r2 !== 'key-and-size-list' ||
    report.deployment !== command.deployment ||
    !Array.isArray(report.files)
  )
    throw new Error('VERIFY_AUDIT_INVALID');
  const files = report.files.filter(f => [1, 2, 3].includes(storageClass(f)));
  if (new Set(files.map(f => f.storageId)).size !== files.length) throw new Error('VERIFY_AUDIT_INVALID');
  let state;
  try {
    state = JSON.parse(await readFile(command.out, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (state && !command.resume) throw new Error('VERIFY_USE_RESUME');
  if (
    command.resume &&
    (!state ||
      state.schema !== 1 ||
      state.auditSha256 !== auditSha256 ||
      state.deployment !== command.deployment)
  )
    throw new Error('VERIFY_STATE_INVALID');
  state ??= {
    schema: 1,
    operationId: randomUUID(),
    deployment: command.deployment,
    auditSha256,
    startedAt: new Date().toISOString(),
    offset: 0,
    results: [],
    complete: false,
    metrics: { queryAttempts: 0, metadataDocuments: 0, r2Gets: 0, r2Bytes: 0, convexGets: 0, convexBytes: 0 },
  };
  if (state.complete) return state;
  await privateJson(command.out, state);
  const io = options.io ?? verificationIo(await reader.r2Config(), state.metrics);
  while (state.offset < files.length) {
    const page = files.slice(state.offset, state.offset + 100);
    state.metrics.queryAttempts++;
    await privateJson(command.out, state);
    const current = await reader.page(metadataSource(page));
    if (!Array.isArray(current) || current.length !== page.length) throw new Error('VERIFY_PAGE_INVALID');
    state.metrics.metadataDocuments += current.filter(Boolean).length;
    const results = new Array(page.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(32, page.length) }, async () => {
        for (;;) {
          const index = next++;
          if (index >= page.length) break;
          const file = page[index];
          try {
            results[index] = await verifyFile(file, current[index], io);
          } catch (error) {
            results[index] = {
              storageId: file.storageId,
              class: storageClass(file),
              bytes: file.bytes,
              fullDigest: false,
              code: /^VERIFY_[A-Z_]+$/.test(error.message) ? error.message : 'VERIFY_DOWNLOAD_FAILED',
            };
          }
        }
      }),
    );
    state.results.push(...results);
    state.offset += page.length;
    state.updatedAt = new Date().toISOString();
    await privateJson(command.out, state);
    options.progress?.(verificationSummary(state));
  }
  state.complete = true;
  state.finishedAt = new Date().toISOString();
  await privateJson(command.out, state);
  return state;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const command = parseVerification(process.argv.slice(2));
    const state = await verify(command, deploymentReader(command.deployment, root), {
      progress: p => console.error(JSON.stringify(p)),
    });
    console.log(JSON.stringify(verificationSummary(state)));
  } catch (error) {
    const code = /^VERIFY_[A-Z_]+$/.test(error.message ?? '') ? error.message : 'VERIFY_READ_FAILED';
    console.error(
      JSON.stringify({
        error: {
          code,
          message:
            'Read-only verification stopped; resume the same private evidence. No migration or deletion occurred.',
        },
      }),
    );
    process.exitCode = 1;
  }
}
