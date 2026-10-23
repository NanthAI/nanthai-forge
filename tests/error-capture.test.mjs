// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConvexError } from 'convex/values';
import { moduleUrl } from './convex-module.mjs';
const { ErrorReporter, buildHash, captureConvexFailures, installErrorCapture } = await import(
  moduleUrl('../web/src/error-capture.ts')
);

function reporter(options = {}) {
  let time = 0,
    count = 0,
    route = 'https://forge.example/owner/project/work?token=secret-value#section';
  const sent = [];
  const instance = new ErrorReporter({
    build: 'Ab12Cd34',
    route: () => route,
    projectId: () => 'project',
    now: () => time,
    id: () => `operation-${count++}`,
    ...options,
  });
  return {
    instance,
    sent,
    sink: report => (sent.push(report), Promise.resolve(null)),
    advance: ms => (time += ms),
    route: value => (route = value),
  };
}

test('reporter dedupes repeats, throttles bursts and queues until a sink attaches', async () => {
  const r = reporter({ maxPerWindow: 3, windowMs: 1000, repeatMs: 5000 });
  assert.equal(r.instance.capture('error', new Error('Early')), true);
  assert.equal(r.sent.length, 0);
  const detach = r.instance.attach(r.sink);
  assert.deepEqual(
    r.sent.map(report => report.message),
    ['Error: Early'],
  );
  const repeat = () => new Error('Same failure');
  assert.equal(r.instance.capture('error', repeat()), true);
  assert.equal(r.instance.capture('error', repeat()), false);
  assert.equal(r.instance.capture('error', new Error('Third')), true);
  assert.equal(r.instance.capture('error', new Error('Throttled')), false);
  r.advance(1000);
  assert.equal(r.instance.capture('error', repeat()), false, 'still inside the repeat window');
  assert.equal(r.instance.capture('error', new Error('After window')), true);
  r.advance(5000);
  assert.equal(r.instance.capture('error', repeat()), true);
  detach();
  r.instance.capture('error', new Error('Queued after detach'));
  assert.equal(r.sent.length, 5);
  const failing = reporter();
  failing.instance.attach(() => Promise.reject(new Error('offline')));
  assert.equal(failing.instance.capture('error', new Error('Report send fails quietly')), true);
  await new Promise(resolve => setImmediate(resolve));
});

test('reports keep only URL paths and redact token-shaped text', () => {
  const r = reporter();
  r.instance.attach(r.sink);
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.c2lnbmF0dXJlLXZhbHVl';
  const error = new Error(`Fetch https://api.example/x?access_token=${jwt}&b=2 failed, password: hunter2`);
  error.stack = `Error\n    at go (https://forge.example/assets/Hosted-Zz99Yy88.js?import#x:10:5)`;
  r.instance.capture('unhandledrejection', error);
  r.route('/device?code=ABCD-EFGH');
  r.instance.capture('error', 'string failure fga_abcdefghijkl');
  r.instance.capture('error', { secret: 'object payload' });
  const [first, second, third] = r.sent;
  assert.equal(first.route, '/owner/project/work');
  assert.equal(first.message, 'Error: Fetch https://api.example/x failed, password: [redacted]');
  assert.equal(first.stack, 'Error\n    at go (https://forge.example/assets/Hosted-Zz99Yy88.js)');
  assert.equal(first.projectId, 'project');
  assert.equal(first.build, 'Ab12Cd34');
  assert.equal(second.route, '/device');
  assert.equal(second.message, 'string failure [redacted]');
  assert.equal(third.message, 'A non-Error value was thrown.');
  assert.doesNotMatch(JSON.stringify(r.sent), /secret-value|hunter2|ABCD|object payload|eyJ/);
});

test('failed Convex calls report function and code once, rethrow unchanged and skip the report call', async () => {
  const r = reporter();
  r.instance.attach(r.sink);
  const failure = new ConvexError({
    code: 'PROJECT_UNAVAILABLE',
    message: 'This Forge project is unavailable.',
  });
  const client = {
    mutation: async (name, args) => {
      if (name === 'ok:mutation') return args.value;
      throw failure;
    },
    action: async () => {
      throw new Error('[CONVEX A(projectWorkActions:run)] Server Error');
    },
  };
  captureConvexFailures(client, r.instance);
  assert.equal(await client.mutation('ok:mutation', { value: 7 }), 7);
  await assert.rejects(client.mutation('projectWork:save', {}), error => error === failure);
  await assert.rejects(client.mutation('clientErrors:report', {}), error => error === failure);
  await assert.rejects(client.action('projectWorkActions:run', {}), /Server Error/);
  assert.equal(r.instance.capture('unhandledrejection', failure), false, 'already reported');
  assert.deepEqual(
    r.sent.map(report => [report.kind, report.functionName, report.code, report.message]),
    [
      ['mutation', 'projectWork:save', 'PROJECT_UNAVAILABLE', 'This Forge project is unavailable.'],
      [
        'action',
        'projectWorkActions:run',
        undefined,
        'Error: [CONVEX A(projectWorkActions:run)] Server Error',
      ],
    ],
  );
});

test('window listeners report errors and rejections, ignoring opaque cross-origin script errors', () => {
  const r = reporter();
  r.instance.attach(r.sink);
  const target = new EventTarget();
  installErrorCapture(target, r.instance);
  target.dispatchEvent(Object.assign(new Event('error'), { message: 'Script error.', error: null }));
  target.dispatchEvent(Object.assign(new Event('error'), { message: 'x', error: new TypeError('Boom') }));
  target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new Error('Rejected') }));
  assert.deepEqual(
    r.sent.map(report => [report.kind, report.message]),
    [
      ['error', 'TypeError: Boom'],
      ['unhandledrejection', 'Error: Rejected'],
    ],
  );
});

test('build hash comes from the hashed entry chunk name', () => {
  assert.equal(buildHash('https://forge.example/assets/index-Ab12_Cd-.js'), 'Ab12_Cd-');
  assert.equal(buildHash('http://localhost:5173/src/error-capture.ts'), 'dev');
  assert.equal(buildHash('data:text/javascript;base64,AAAA'), 'dev');
});
