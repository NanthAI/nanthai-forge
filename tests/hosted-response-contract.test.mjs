// SPDX-License-Identifier: Apache-2.0
// Old CLI vs new server (Issue 3205f7e6): hosted replies drop unknown keys and keep every other check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { moduleUrl } from './convex-module.mjs';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { parseHostedResponse, safeParseHostedResponse } from '../dist/hosted-response.js';
import { hostedAgentCapabilitiesSchema } from '../dist/hosted-agent-contract.js';
import { effectiveAgentDefaultsSchema } from '../dist/agent-parallel-defaults.js';
import { hostedContractFeatures } from '../dist/hosted-contract-features.js';
import {
  checkResponseCompatibility,
  responseIssues,
  responseSchemas,
  responseSnapshotPath,
} from '../scripts/response-compat.mjs';
const { capabilities } = await import(moduleUrl('../convex/projectHostedAgent.ts'));

/** The capability read exactly as the current CLI sends it (src/hosted-agent-transport.ts). */
async function candidateCapabilities() {
  const s = lanesFixture();
  const projectId = s.insert('hostedProjects', {
    key: 'synthetic',
    name: 'Synthetic',
    currentBackup: null,
    revision: 0,
    owner: 'owner',
    visibility: 'private',
    sourceAuthority: { mode: 'server', epoch: 2 },
  });
  const options = {
    clientVersion: '0.0.0-test',
    features: [...hostedContractFeatures],
    noticeVersion: 1,
    resolveVersion: 1,
    overlapVersion: 1,
    overlapEvidenceVersion: 1,
    mirrorVersion: 1,
    metricReceiptVersion: 1,
    planningVersion: 1,
    defaultsVersion: 1,
    landingMessageVersion: 1,
    openLanesVersion: 1,
  };
  return JSON.parse(await s.call('capabilities', capabilities, { projectId, ...options }, 'owner'));
}
const released = JSON.parse(readFileSync(new URL(`../${responseSnapshotPath}`, import.meta.url), 'utf8'));
const releasedSchema = id => z.fromJSONSchema(released.schemas[id]);

test('incident replay: a strict CLI rejects an added agentDefaults field; the reply boundary drops it', async () => {
  const reply = await candidateCapabilities();
  // e293c4e7 parsed agentDefaults with this strict six-key schema; 8d28c25f's server added autoClaim
  // (fe3b6292 then froze the wire keys: WIRE_AGENT_DEFAULT_KEYS).
  const e293 = effectiveAgentDefaultsSchema.strict();
  const sent8d28 = { ...reply.agentDefaults, autoClaim: true };
  const strict = e293.safeParse(sent8d28);
  assert.equal(strict.success, false);
  assert.deepEqual(
    strict.error.issues.map(issue => [issue.code, issue.keys]),
    [['unrecognized_keys', ['autoClaim']]],
  );
  assert.deepEqual(parseHostedResponse(e293, sent8d28), e293.parse(reply.agentDefaults));
});

test('guard: a server reply with extra unknown fields parses on the current CLI', async () => {
  const reply = await candidateCapabilities();
  const extended = {
    ...reply,
    futureTopLevel: { any: 'shape' },
    authority: { ...reply.authority, futureNested: 1 },
    agentDefaults: {
      ...reply.agentDefaults,
      futureDefault: true,
      stallAlerts: { ...reply.agentDefaults.stallAlerts, futureAlert: 'x' },
    },
  };
  const before = JSON.stringify(extended);
  const parsed = parseHostedResponse(hostedAgentCapabilitiesSchema, extended);
  assert.equal(JSON.stringify(extended), before, 'the input is never mutated');
  assert.equal('futureTopLevel' in parsed, false);
  assert.equal('futureNested' in parsed.authority, false);
  assert.equal('futureDefault' in parsed.agentDefaults, false);
  assert.equal('futureAlert' in parsed.agentDefaults.stallAlerts, false);
  assert.deepEqual(parsed, hostedAgentCapabilitiesSchema.parse(reply));
});

test('the reply boundary still rejects missing, wrong-typed and unknown-enum fields', async () => {
  const reply = await candidateCapabilities();
  const { actor: _actor, ...missing } = reply;
  for (const [label, value] of [
    ['missing required', { ...missing, extra: 1 }],
    ['wrong type', { ...reply, mainReady: 'yes', extra: 1 }],
    ['unknown enum value', { ...reply, observation: 'live' }],
    [
      'nested wrong type',
      { ...reply, agentDefaults: { ...reply.agentDefaults, preflightMaxMinutes: 'ten', extra: 1 } },
    ],
  ]) {
    assert.equal(safeParseHostedResponse(hostedAgentCapabilitiesSchema, value).success, false, label);
    assert.throws(() => parseHostedResponse(hostedAgentCapabilitiesSchema, value), z.ZodError, label);
  }
});

test('unknown keys are dropped inside arrays, records and unions', () => {
  const a = z.object({ k: z.literal('a'), x: z.number() }).strict();
  const b = z.object({ k: z.literal('a'), x: z.number(), y: z.string() }).strict();
  const schema = z
    .object({ list: z.array(z.union([a, b])), map: z.record(z.string(), a), pick: z.union([a, b]) })
    .strict();
  const parsed = parseHostedResponse(schema, {
    list: [{ k: 'a', x: 1, e: 1 }],
    map: { one: { k: 'a', x: 2, e: 2 } },
    pick: { k: 'a', x: 3, y: 's', e: 3 },
    top: true,
  });
  assert.deepEqual(parsed, {
    list: [{ k: 'a', x: 1 }],
    map: { one: { k: 'a', x: 2 } },
    pick: { k: 'a', x: 3, y: 's' },
  });
});

test('landing guard: the released CLI contract accepts the Candidate server capability reply', async () => {
  const reply = await candidateCapabilities();
  const old = releasedSchema('hosted-agent-contract#hostedAgentCapabilitiesSchema');
  // The released contract is strict, like the CLI's own schemas; the boundary drops what it lacks.
  parseHostedResponse(old, { ...reply, futureTopLevel: 1 });
});

test('landing guard: Candidate reply contracts stay compatible with the released CLI', async () => {
  const { issues, undeclared } = await checkResponseCompatibility(new URL('..', import.meta.url).pathname);
  assert.deepEqual(
    undeclared.map(issue => `${issue.path}: ${issue.detail}`),
    [],
    `A released CLI would reject replies this Candidate allows. Keep the old reply shape for clients that do not advertise a new contract feature (src/hosted-contract-features.ts), then declare the change in scripts/response-compat/declared.json with its feature name: ${JSON.stringify(undeclared.map(({ path, change }) => ({ path, change, reason: 'feature-gated: NAME' })))}`,
  );
  assert(issues.length >= undeclared.length);
});

test('response compatibility: additive changes pass; narrowing changes fail', () => {
  const snapshot = schema => ({
    format: 1,
    unknownKeys: 'strip',
    schemas: { reply: z.toJSONSchema(schema, { io: 'input' }) },
  });
  const base = z
    .object({ id: z.string(), state: z.enum(['open', 'closed']), note: z.string().optional() })
    .strict();
  const kinds = next =>
    responseIssues(snapshot(base), snapshot(next)).map(issue => `${issue.path}:${issue.kind}`);
  assert.deepEqual(kinds(base.extend({ added: z.number() }).strict()), []);
  assert.deepEqual(kinds(base.extend({ note: z.string().optional(), more: z.boolean().optional() })), []);
  assert.deepEqual(kinds(base.extend({ id: z.string().optional() })), ['reply.id:field-required']);
  assert.deepEqual(kinds(base.omit({ id: true })), ['reply.id:field-required']);
  assert.deepEqual(kinds(base.extend({ state: z.enum(['open', 'closed', 'parked']) })), [
    'reply.state:enum-narrowed',
  ]);
  assert.deepEqual(kinds(base.extend({ id: z.number() })), ['reply.id:type-narrowed']);
  assert.throws(() => responseIssues({ ...snapshot(base), unknownKeys: undefined }, snapshot(base)), /strip/);
});

test('hosted replies of the snapshotted schemas go through the reply boundary', () => {
  const names = responseSchemas.map(([, name]) => name).join('|');
  const direct = new RegExp(
    `\\b(${names})\\.(safeParse|parse)\\(\\s*(await\\s|[\\w.]*\\.result\\b|result\\b)`,
  );
  const found = [];
  const src = new URL('../src/', import.meta.url);
  for (const file of readdirSync(src)) {
    if (!file.endsWith('.ts')) continue;
    const text = readFileSync(new URL(file, src), 'utf8');
    if (direct.test(text)) found.push(file);
  }
  assert.deepEqual(found, [], 'use parseHostedResponse(schema, reply) for hosted replies');
});
