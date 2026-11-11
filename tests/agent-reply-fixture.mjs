// SPDX-License-Identifier: Apache-2.0
// Fixed-width, synthetic receipts matching the hosted CLI boundary. Measure printed UTF-8 JSON,
// including its newline; never compare these bytes with provider tokens or live billing.
export const laneId = '11111111-1111-4111-8111-111111111111';
export const operationId = '22222222-2222-4222-8222-222222222222';
export const head = 'a'.repeat(64);
export const root = '/work/project.forge-client/lanes/' + laneId;
const lane = { laneId, intentId: laneId, head, version: 1, base: { head } };
const envelope = (action, result, extra = {}) => ({
  schema: 1,
  transport: 'hosted',
  cliCommit: head,
  action,
  operationId,
  resolved: { operationId },
  result,
  ...extra,
});
const outcome = result => ({ outcome: { status: 'completed', result } });
const applied = { ...lane, root, downloadedObjects: 0, downloadedBytes: 0 };
const continuation = {
  next: { action: 'resolve', laneId, operationId },
  command: `nforge agent '${root}' resolve '{"laneId":"${laneId}","operationId":"${operationId}"}'`,
};
const content = 'unchanged source line\n'.repeat(2000) + '<<<<<<< lane\nleft\n=======\nright\n>>>>>>> main\n';
const conflict = {
  root,
  laneId,
  head,
  paths: ['src/a.ts'],
  more: 0,
  files: [{ path: 'src/a.ts', content }],
  ...continuation,
  workIn: `WORK IN ${root} (resolution Lane ${laneId})`,
  automatic: {
    summary: 'Opened the resolution Lane with conflict markers.',
    undo: 'Abandon this Lane to continue in the original.',
  },
};
const submission = {
  id: operationId,
  operationId,
  phase: 'landed',
  request: { agent: true, check: { kind: 'request' } },
  acceptance: { receiptId: operationId, head },
  testFiles: { counts: { total: 800, failed: 0, flaky: 0 }, failed: [], flaky: [] },
};
const tests = Array.from({ length: 80 }, (_, i) => `tests/local-${i}.test.mjs`);
const deferredTests = Array.from({ length: 300 }, (_, i) => `tests/deferred-${i}.test.mjs`);
export const boardMessages = [0, 1].map(i => ({
  id: operationId.slice(0, -1) + i,
  target: 'project',
  text: 'A project note ' + 'x'.repeat(150),
  author: 'peer/quiet-otter',
  at: 50 + i,
}));
export const replies = {
  start: envelope('start', { lane, path: root, checkout: applied, dependencies: { status: 'linked' } }),
  save: envelope('save', outcome({ laneId, head, operationId, at: '2026-01-01T00:00:00.000Z' })),
  sync: envelope('sync', { source: outcome({ status: 'merged', lane }), applied }),
  resolve: envelope('resolve', { source: outcome({ status: 'resolved', lane }), applied, ...continuation }),
  land: envelope('finish', { submission, defaults: { preflight: { status: 'passed' } } }),
  wait: envelope('observe', {
    status: 'terminal',
    successful: true,
    submissions: [{ operationId, submission }],
    cursor: 'c'.repeat(160),
  }),
  conflict: envelope('sync', {
    source: outcome({ status: 'conflict', lane, resolution: { left: head, right: head } }),
    conflict,
  }),
  preflight: envelope('preflight', {
    laneId,
    head,
    plan: {
      status: 'planned',
      scope: 'partial',
      reason: 'Affected tests',
      tests,
      deferredTests,
      estimateMinutes: 6,
      command: 'node --test ' + tests.join(' '),
      local: {
        rule: 'changed then direct then transitive',
        tiers: [{ tier: 'direct', total: 80, local: 80 }],
        tierTests: { direct: tests },
        trimmedTests: deferredTests,
        budgetSeconds: 180,
        mandatory: 1,
        deferred: 300,
        deferredTo: 'pre-queue',
        summary: '80 local, 300 deferred',
      },
    },
  }),
  board: envelope('board', {
    status: 'ok',
    messages: boardMessages,
    more: 0,
    cursor: 51,
    notices: boardMessages.map(m => `Note ${m.id}: ${m.text}`),
  }),
};
export const replyBytes = value => Buffer.byteLength(JSON.stringify(value) + '\n', 'utf8');
