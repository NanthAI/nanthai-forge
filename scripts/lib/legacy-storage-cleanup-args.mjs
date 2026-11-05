// SPDX-License-Identifier: Apache-2.0
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export function parseCleanup(args) {
  const { values: v, positionals: p } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      deployment: { type: 'string' },
      audit: { type: 'string' },
      verification: { type: 'string' },
      'body-coverage': { type: 'string' },
      'bench-manifest': { type: 'string' },
      out: { type: 'string' },
      'operation-id': { type: 'string' },
      'lead-go': { type: 'string' },
    },
  });
  if (
    p.length !== 1 ||
    !['dry-run', 'apply', 'resume-writes'].includes(p[0]) ||
    !v.deployment?.startsWith('dev:') ||
    (p[0] !== 'resume-writes' && (!v.audit || !v.verification || !v['body-coverage'])) ||
    !v.out ||
    (p[0] === 'apply' &&
      (!v['lead-go']?.trim() ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v['operation-id'] ?? '')))
  )
    throw new Error('CLEANUP_ARGUMENT_INVALID');
  const out = resolve(v.out);
  if (out === root || out.startsWith(root + '/')) throw new Error('CLEANUP_PRIVATE_OUTPUT_REQUIRED');
  return {
    mode: p[0],
    deployment: v.deployment,
    audit: v.audit ? resolve(v.audit) : null,
    verification: v.verification ? resolve(v.verification) : null,
    out,
    bodyCoverage: v['body-coverage'] ? resolve(v['body-coverage']) : null,
    benchManifest: v['bench-manifest'] ? resolve(v['bench-manifest']) : null,
    operationId: v['operation-id'],
    leadGo: v['lead-go'],
  };
}
