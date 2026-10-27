// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
const errors = await import(moduleUrl('../convex/clientErrors.ts'));
const paginationOpts = { numItems: 20, cursor: null };
const unavailable = error => error.data?.code === 'PROJECT_UNAVAILABLE';

function setup() {
  const s = state([]);
  s.tables.clientErrors = new Map();
  s.tables.hostedProjects.set('project', {
    _id: 'project',
    _creationTime: 1,
    owner: 'owner',
    visibility: 'private',
  });
  s.tables.projectReaders.set('grant', { _id: 'grant', projectId: 'project', reader: 'reader' });
  const report = (patch = {}) =>
    errors.report._handler(s.ctx, {
      operationId: crypto.randomUUID(),
      kind: 'mutation',
      message: 'Synthetic failure',
      route: '/owner/project/work',
      build: 'Ab12Cd34',
      projectId: 'project',
      ...patch,
    });
  const rows = () => [...s.tables.clientErrors.values()];
  return { s, report, rows };
}

test('client error reports take the user from auth, drop anonymous callers and reconcile retries', async () => {
  const { s, report, rows } = setup();
  const id = await report({ operationId: 'operation-one', user: 'someone-else' });
  assert.equal(await report({ operationId: 'operation-one', message: 'Different retry payload' }), id);
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].user, 'owner');
  assert.equal(rows()[0].message, 'Synthetic failure');
  s.caller(undefined);
  assert.equal(await report(), null);
  assert.equal(rows().length, 1);
  s.caller('owner');
  await assert.rejects(report({ operationId: 'x' }), error => error.data?.code === 'BAD_ARGUMENT');
});

test('client error fields are scrubbed and truncated before storage', async () => {
  const { report, rows } = setup();
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.c2lnbmF0dXJlLXZhbHVl';
  await report({
    message: `Failed https://forge.example/owner/project?token=${jwt} with Bearer abc.def ${'x'.repeat(900)}`,
    stack: `Error\n    at f (https://forge.example/assets/index-Ab12Cd34.js?v=1#frag:1:2)\n    api_key=sk_live_abcdefghij ${'y'.repeat(9000)}`,
    route: `https://user:pass@forge.example/owner/project/code/${'a'.repeat(600)}?code=DEVICE#L3`,
    build: 'Ab12<script>Cd34',
    functionName: `projectWork:${'z'.repeat(300)}`,
    code: '   ',
  });
  const [row] = rows();
  assert.equal(row.message.length, 500);
  assert.match(row.message, /^Failed https:\/\/forge\.example\/owner\/project with Bearer \[redacted\]/);
  assert.ok(row.stack.length <= 4000);
  assert.match(row.stack, /index-Ab12Cd34\.js\)/);
  assert.doesNotMatch(row.stack, /v=1|frag|sk_live/);
  assert.match(row.stack, /api_key=\[redacted\]/);
  assert.equal(row.route.length, 300);
  assert.ok(row.route.startsWith('/owner/project/code/'));
  assert.doesNotMatch(row.route, /pass|DEVICE|L3|\?/);
  assert.equal(row.build, 'Ab12scriptCd34');
  assert.equal(row.functionName.length, 120);
  assert.equal('code' in row, false);
  for (const value of Object.values(row)) assert.doesNotMatch(String(value), new RegExp(jwt.slice(0, 20)));
});

test('a project is attached only under current access', async () => {
  const { s, report, rows } = setup();
  s.caller('stranger');
  await report();
  s.caller('reader');
  await report();
  await report({ projectId: 'not-a-project' });
  s.tables.projectReaders.clear();
  await report();
  assert.deepEqual(
    rows().map(row => [row.user, row.projectId]),
    [
      ['stranger', undefined],
      ['reader', 'project'],
      ['reader', undefined],
      ['reader', undefined],
    ],
  );
});

test('only the project owner lists recent errors, newest first, without naming other reporters', async () => {
  const { s, report } = setup();
  await report({ message: 'Owner failure' });
  s.caller('reader');
  await report({ message: 'Reader failure', kind: 'render' });
  await assert.rejects(errors.recent._handler(s.ctx, { projectId: 'project', paginationOpts }), unavailable);
  s.caller('stranger');
  await assert.rejects(errors.recent._handler(s.ctx, { projectId: 'project', paginationOpts }), unavailable);
  s.caller(undefined);
  await assert.rejects(errors.recent._handler(s.ctx, { projectId: 'project', paginationOpts }), unavailable);
  s.caller('owner');
  const { page } = await errors.recent._handler(s.ctx, { projectId: 'project', paginationOpts });
  assert.deepEqual(
    page.map(row => [row.message, row.kind, row.reportedByYou, 'user' in row]),
    [
      ['Reader failure', 'render', false, false],
      ['Owner failure', 'mutation', true, false],
    ],
  );
  s.tables.hostedProjects.get('project').removal = 'deleting';
  await assert.rejects(errors.recent._handler(s.ctx, { projectId: 'project', paginationOpts }), unavailable);
});
