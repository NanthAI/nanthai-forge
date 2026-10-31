// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validate } from 'convex-helpers/validators';
import { moduleUrl } from './convex-module.mjs';
import {
  AGENT_DEFAULTS,
  agentDefaultLines,
  effectiveAgentDefaults,
  urgentAllowed,
} from '../dist/agent-parallel-defaults.js';
import {
  editedPolicy,
  effectivePolicy,
  policyPreset,
  policyReadView,
  samePolicy,
} from '../dist/autonomy-policy.js';
import { acceptancePolicyDigest } from '../dist/policy-digest.js';
import { digest } from '../dist/portable-hash.js';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
import { llmDocuments } from '../scripts/llm-documents.mjs';

const { autonomyPolicy } = await import(moduleUrl('../convex/autonomyFields.ts'));
const edit = (policy, agentDefaults) =>
  editedPolicy(policy, { action: 'set-policy', operationId: crypto.randomUUID(), agentDefaults });

test('every default is on; absent stored fields read as the documented defaults', () => {
  assert.deepEqual(effectiveAgentDefaults(undefined), AGENT_DEFAULTS);
  assert.deepEqual(AGENT_DEFAULTS, {
    preflight: 'require',
    preflightMaxMinutes: 10,
    urgentRoles: ['owner'],
    overlapGate: 'block',
    checkpointNudgeMinutes: 30,
    stallAlerts: { enabled: true, notifyAfterMinutes: 15, repeatAfterMinutes: 30, email: [], webhook: 'off' },
  });
  const view = policyReadView(effectivePolicy({}));
  assert.deepEqual(view.agentDefaults, AGENT_DEFAULTS, 'policy read shows effective values');
});

test('set-policy edits one field at a time, stores in the Convex validator and keeps the rest', () => {
  let policy = edit(policyPreset('trusted'), { preflight: 'advise' });
  policy = edit(policy, { stallAlerts: { webhook: 'ntfy' } });
  policy = edit(policy, { stallAlerts: { email: ['owner@example.com'] } });
  assert.deepEqual(policy.agentDefaults, {
    preflight: 'advise',
    stallAlerts: { webhook: 'ntfy', email: ['owner@example.com'] },
  });
  assert.equal(policy.preset, 'custom');
  assert.equal(validate(autonomyPolicy, policy), true);
  assert.equal(validate(autonomyPolicy, policyReadView(policy)), true);
  const effective = effectiveAgentDefaults(policy.agentDefaults);
  assert.equal(effective.overlapGate, 'block');
  assert.equal(effective.stallAlerts.repeatAfterMinutes, 30);
  assert.throws(() => edit(policy, { stallAlerts: { notifyAfterMinutes: 40, repeatAfterMinutes: 30 } }));
  assert.throws(() => edit(policy, { stallAlerts: { email: ['not-an-address'] } }));
  assert.throws(
    () => edit(policy, { stallAlerts: { webhookUrl: 'https://ntfy.sh/secret' } }),
    'no URL field',
  );
});

test('compare-and-swap accepts the read view; landing pins ignore agent defaults', () => {
  const stored = policyPreset('trusted');
  assert(samePolicy(policyReadView(stored), stored));
  assert(samePolicy(stored, stored));
  assert(!samePolicy({ ...stored, laneUpdates: 'ask' }, stored));
  // Existing policies keep their digests, so a deploy never invalidates a queued landing.
  assert.equal(acceptancePolicyDigest(stored), digest(canonicalPayload(stored)));
  assert.equal(
    acceptancePolicyDigest(edit(stored, { preflight: 'off' })),
    acceptancePolicyDigest({ ...stored, preset: 'custom' }),
  );
});

test('urgent roles: owner in person or asOwner; agents only when allowed; never another account', () => {
  const owner = 'owner',
    defaults = effectiveAgentDefaults(undefined);
  const allowed = (actor, asOwner, d = defaults) => urgentAllowed(d, { owner, actor, asOwner });
  assert.equal(allowed({ id: owner, kind: 'person' }), true);
  assert.equal(allowed({ id: owner, kind: 'agent' }, true), true);
  assert.equal(allowed({ id: owner, kind: 'agent' }), false);
  assert.equal(
    allowed(
      { id: owner, kind: 'agent' },
      false,
      effectiveAgentDefaults({ urgentRoles: ['owner', 'agents'] }),
    ),
    true,
  );
  assert.equal(allowed({ id: 'contributor', kind: 'person' }, true), false);
  assert.equal(
    allowed({ id: owner, kind: 'person' }, false, effectiveAgentDefaults({ urgentRoles: [] })),
    false,
  );
});

test('agent text: one line per active rule, nothing for rules that are off', () => {
  const all = agentDefaultLines(AGENT_DEFAULTS);
  assert(all.some(line => line.includes('preflight') && line.includes('refuses')));
  assert(all.some(line => line.includes(' ack ')));
  assert(all.some(line => line.includes('30 minutes')));
  assert(all.some(line => /urgent/.test(line)));
  assert(
    all.every(line => line.length <= 200),
    'terse',
  );
  const off = agentDefaultLines(
    effectiveAgentDefaults({
      preflight: 'off',
      overlapGate: 'off',
      checkpointNudgeMinutes: 0,
      urgentRoles: ['owner', 'agents'],
      stallAlerts: { enabled: false },
    }),
  );
  assert(!off.some(line => /preflight|ack|minutes of edits|urgent|LANDING_STALLED/.test(line)));
  assert.equal(off.length, 3, 'only the always-on rules remain');
  assert(agentDefaultLines(effectiveAgentDefaults({ preflight: 'advise' }))[0].endsWith('(advisory).'));
});

test('the packaged skill and llms.txt carry exactly the generated default lines', () => {
  const skill = readFileSync(new URL('../skills/forge-agent/SKILL.md', import.meta.url), 'utf8');
  const block = /<!-- agent-defaults:start[^>]*-->\n([\s\S]*?)\n<!-- agent-defaults:end -->/.exec(skill);
  assert(block, 'skill has the generated block');
  assert.deepEqual(
    block[1].split('\n'),
    agentDefaultLines(AGENT_DEFAULTS).map(line => `- ${line}`),
    'regenerate the skill block from scripts/agent-default-lines.mjs',
  );
  const llms = llmDocuments(new URL('..', import.meta.url).pathname)[0].source;
  for (const line of agentDefaultLines(AGENT_DEFAULTS)) assert(llms.includes(line), line);
  assert(llms.includes('docs/parallel-work-defaults.md'));
});
