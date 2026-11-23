// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item 5a22ee20: the four agent-CLI frictions of 2026-11-18, each with a test that fails without its fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostedAgentHelp, hostedHelpFor } from '../dist/hosted-agent-help.js';
import { helpTopicText } from '../dist/help-topics.js';
import { cliTeachContext, teach } from '../dist/error-teaching.js';
import { hostedActionError, hostedFailureCause, hostedFailureDetail } from '../dist/hosted-action-error.js';
import { cliCanaryNotice, cliNoticeAlways } from '../dist/cli-canary.js';

test('land --save help prints the submission schema and points to save-only (friction 80c97c5c)', () => {
  const text = hostedAgentHelp('finish');
  assert.doesNotMatch(text, /is unavailable/);
  assert.match(text, /land --save/);
  assert.match(text, /"message"/);
  assert.match(helpTopicText('land'), /save without submitting[^\n]*nforge agent \. save/);
  assert.match(hostedHelpFor('land'), /land --save/);
});

test('a cleanOnly refusal on a non-stacked Lane names plain sync (friction 330dcd92)', () => {
  const laneId = '2fb3ca26-d381-4b30-a0fe-ae7615ad84d6';
  const context = cliTeachContext([
    'agent',
    '/work/clone',
    'sync',
    JSON.stringify({ laneId, cleanOnly: true }),
  ]);
  const taught = teach(
    'BAD_ARGUMENT',
    context,
    undefined,
    'cleanOnly restacks a stacked Lane onto its parent; this Lane is not stacked.',
  );
  assert.equal(taught.next, `nforge agent /work/clone save --sync '{"laneId":"${laneId}"}'`);
  // Other BAD_ARGUMENT refusals keep the generic help command.
  assert.match(teach('BAD_ARGUMENT', context, undefined, 'Other.').next, /--help$/);
});

test('a platform failure names its cause class and keeps the request id, never the raw text (514b8223)', () => {
  const error = hostedActionError(
    new Error('[Request ID: a1b2c3d4] Function execution timed out secret-token private-source'),
    'agent finish',
  );
  assert.equal(error.code, 'HOSTED_ACTION_FAILED');
  assert.match(error.message, /cause: server-timeout; Convex request ID: a1b2c3d4/);
  assert.doesNotMatch(error.message, /secret-token|private-source/);
  assert.equal(hostedFailureDetail(error.message), ' (cause: server-timeout; Convex request ID: a1b2c3d4)');
  assert.equal(
    hostedFailureCause(new Error('Too many bytes read in a single function execution')),
    'server-limit',
  );
  assert.equal(hostedFailureCause(new Error('fetch failed')), 'connection');
  assert.equal(hostedFailureCause(new Error('[Request ID: x] Server Error')), 'server-exception');
  // A failure with no server trace happened in this CLI: named, never 'unknown' (Item 3f76a3df).
  assert.equal(hostedFailureCause(new Error('surprising')), 'local-exception');
  assert.match(
    hostedActionError(new Error('Too many documents read'), 'agent finish').message,
    /likely to fail the same way/,
  );
});

test('the release-signature notice prints once per head and stays on status and help (friction 4)', () => {
  const installation = mkdtempSync(join(tmpdir(), 'forge-notice-'));
  try {
    const record = {
      head: 'b'.repeat(40),
      at: new Date().toISOString(),
      step: 'release-signature',
      reason: 'unsigned',
      attempts: 1,
      nextRetryAt: Date.now() + 60_000,
      signaturePending: true,
    };
    const running = 'a'.repeat(40);
    assert.match(cliCanaryNotice(installation, record, running, false), /Details:/);
    // Every later ordinary command is silent; status and help keep the one short line.
    assert.equal(cliCanaryNotice(installation, record, running, false), '');
    assert.equal(cliCanaryNotice(installation, record, running, false), '');
    assert.match(
      cliCanaryNotice(installation, record, running, true),
      /was held until its release signature/,
    );
    assert.equal(cliNoticeAlways(['agent', '.', 'status']), true);
    assert.equal(cliNoticeAlways(['agent', '.', 'help']), true);
    assert.equal(cliNoticeAlways(['status']), true);
    assert.equal(cliNoticeAlways(['--version']), true);
    assert.equal(cliNoticeAlways(['agent', '.', 'save', '{}']), false);
    assert.equal(cliNoticeAlways(['agent', '.', 'save', '--help']), true);
    assert.equal(cliNoticeAlways(['pull']), false);
  } finally {
    rmSync(installation, { recursive: true, force: true });
  }
});
