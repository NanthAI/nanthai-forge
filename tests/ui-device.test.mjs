// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';
const code = await import(moduleUrl('../web/src/device/code.ts'));
const { DeviceApproval } = await import(moduleUrl('../web/src/device/DeviceApproval.tsx'));
const { DeviceListView } = await import(moduleUrl('../web/src/device/DeviceList.tsx'));

test('device codes are paste-tolerant and grouped like the terminal prints them', () => {
  assert.equal(code.formatCode(' qk7pm 2xdht\n'), 'QK7PM-2XDHT');
  assert.equal(code.formatCode('QK7PM-2XDHT-EXTRA'), 'QK7PM-2XDHT');
  assert.equal(code.formatCode('qk7'), 'QK7');
  assert.equal(code.codeComplete('QK7PM2XDHT'), true);
  assert.equal(code.codeComplete('QK7PM-2XD'), false);
  assert.equal(code.codeProblem('This device code expired or is unavailable.'), 'expired');
  assert.equal(code.codeProblem('This device code already has a decision.'), 'used');
  assert.equal(code.codeProblem('Network down'), null);
  assert.equal(code.expiresIn(Date.now() + 8 * 60_000, Date.now()), 'in 8 min');
});

const render = (phase, extra = {}) =>
  renderToStaticMarkup(
    h(DeviceApproval, {
      phase,
      code: 'QK7PM2XDHT',
      setCode() {},
      find() {},
      decide() {},
      restart() {},
      signIn: h('button', null, 'Sign in to approve'),
      now: Date.now(),
      ...extra,
    }),
  );

test('every device state says what to do next, in plain words', () => {
  assert.match(render({ kind: 'signed-out' }), /Sign in to approve[\s\S]*/);
  assert.match(render({ kind: 'signed-out' }), /QK7PM-2XDHT/);
  const review = render({
    kind: 'review',
    request: { name: 'dino-mbp', scope: 'cli', expiresAt: Date.now() + 60_000, state: 'pending' },
  });
  assert.match(review, />Approve</);
  assert.match(review, />Deny</);
  assert.match(review, /30 days, or until you revoke it/);
  assert.doesNotMatch(review, /\bIP\b|location/, 'no facts we do not have');
  assert.match(render({ kind: 'approved', name: 'dino-mbp' }), /return to your terminal/);
  assert.doesNotMatch(render({ kind: 'problem', problem: 'expired' }), /This code has expired/);
  const failure = render({ kind: 'enter' }, { error: 'Offline' });
  assert.match(failure, /aria-invalid="true"/);
  assert.doesNotMatch(failure, />Offline<|role="alert"/);
});

test('revoking a device takes a second click, and old devices fold away', () => {
  const now = Date.now();
  const html = renderToStaticMarkup(
    h(DeviceListView, {
      now,
      revoke: async () => undefined,
      rows: [
        { id: '1', credentialId: 'a', name: 'dino-mbp', scope: 'cli', expiresAt: now + 1e9, revoked: false },
        { id: '2', credentialId: 'b', name: 'old', scope: 'cli', expiresAt: now + 1e9, revoked: true },
      ],
    }),
  );
  assert.match(html, /dino-mbp/);
  assert.match(html, />Revoke</);
  assert.doesNotMatch(html, /Stops working now/);
  assert.match(html, /1 revoked or expired/);
  assert.doesNotMatch(html, />old</);
});
