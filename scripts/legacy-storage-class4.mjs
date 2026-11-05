// SPDX-License-Identifier: Apache-2.0
// Offline only: builds the private owner-approved class 4 manifest. Zero provider calls.
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { privateJson } from './lib/legacy-storage-journal.mjs';
import { buildClass4Approval } from './lib/legacy-storage-class4.mjs';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
export function parseClass4(args) {
  const { values: v } = parseArgs({
    args,
    options: {
      deployment: { type: 'string' },
      audit: { type: 'string' },
      attribution: { type: 'string' },
      'body-coverage': { type: 'string' },
      decision: { type: 'string' },
      out: { type: 'string' },
    },
  });
  if (!v.deployment?.startsWith('dev:') || !v.audit || !v.attribution || !v['body-coverage'] || !v.out)
    throw new Error('CLASS4_ARGUMENT_INVALID');
  const out = resolve(v.out);
  if (out === root || out.startsWith(root + '/')) throw new Error('CLASS4_PRIVATE_OUTPUT_REQUIRED');
  return {
    deployment: v.deployment,
    audit: resolve(v.audit),
    attribution: resolve(v.attribution),
    bodyCoverage: resolve(v['body-coverage']),
    decision: v.decision,
    out,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const command = parseClass4(process.argv.slice(2));
    const approval = await buildClass4Approval(command);
    await privateJson(command.out, approval);
    console.log(
      JSON.stringify({
        totals: approval.totals,
        deletedProjectLinked: approval.deletedProjectLinked,
        retained: approval.retained,
        sha256: approval.sha256,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        error: {
          code: /^(?:CLASS4|CLEANUP)_[A-Z0-9_]+$/.test(error.message ?? '') ? error.message : 'CLASS4_FAILED',
          message: 'Class 4 disposition stopped. No files changed.',
        },
      }),
    );
    process.exitCode = 1;
  }
}
