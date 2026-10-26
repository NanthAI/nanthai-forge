// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { checkRunSchema } from '../dist/work-types.js';
export function runFixture(head = 'a'.repeat(64)) {
  return checkRunSchema.parse({
    id: randomUUID(),
    viewId: randomUUID(),
    head,
    base: head,
    inputs: [],
    dependencies: [],
    check: {
      id: randomUUID(),
      name: 'Synthetic check',
      executable: 'node',
      args: [],
      definition: 'b'.repeat(64),
      environmentLabel: 'synthetic',
      at: '2026-01-01T00:00:00Z',
    },
    environment: {
      fingerprint: 'c'.repeat(64),
      node: process.version,
      os: process.platform,
      platform: process.platform,
      arch: process.arch,
      env: {},
      tools: [],
    },
    runner: { pid: 42, host: 'synthetic' },
    status: 'passed',
    startedAt: '2026-01-01T00:00:00Z',
    endedAt: '2026-01-01T00:01:00Z',
    exitCode: 0,
    details: 'Synthetic complete result',
    backend: {
      requested: 'modal',
      actual: 'modal',
      verdict: 'clean',
      testVerdicts: [
        { test: 'tests/a.test.mjs :: passes', verdict: 'passed' },
        { test: 'tests/b.test.mjs :: fails', verdict: 'failed' },
        {
          test: 'tests/c.test.mjs :: recovers',
          verdict: 'flake',
          recovery: 'unchanged-source',
          evidenceRunId: randomUUID(),
        },
      ],
    },
    checkSelection: {
      scope: 'full',
      reason: 'Synthetic full inventory',
      tests: ['tests/a.test.mjs', 'tests/b.test.mjs'],
      coverage: {
        mode: 'shadow',
        currentCount: 2,
        coverageCount: 1,
        tests: ['tests/a.test.mjs'],
        fallback: null,
      },
    },
  });
}
