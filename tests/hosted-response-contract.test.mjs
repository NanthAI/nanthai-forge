// SPDX-License-Identifier: Apache-2.0
// Old CLI vs new server (Issue 3205f7e6): hosted replies drop unknown keys and keep every other check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { moduleUrl } from './convex-module.mjs';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { randomUUID } from 'node:crypto';
import {
  isHostedReplyError,
  parseHostedOutcome,
  parseHostedResponse,
  safeParseHostedResponse,
} from '../dist/hosted-response.js';
import { hostedLandingStateSchema } from '../dist/hosted-landing.js';
import { hostedAgentCapabilitiesSchema } from '../dist/hosted-agent-contract.js';
import { effectiveAgentDefaultsSchema } from '../dist/agent-parallel-defaults.js';
import { hostedContractFeatures } from '../dist/hosted-contract-features.js';
import {
  checkResponseCompatibility,
  replyBreakMessage,
  responseIssues,
  responseSchemas,
  responseSnapshot,
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
  // e293c4e7 still had overlapGate (retired in Issue 853fcde3; the server keeps sending it).
  const e293 = effectiveAgentDefaultsSchema
    .extend({ overlapGate: z.enum(['off', 'warn', 'block']) })
    .strict();
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

test('landing guard: Candidate reply contracts stay compatible with the previous main build', async () => {
  const { main } = await checkResponseCompatibility(new URL('..', import.meta.url).pathname);
  assert.deepEqual(
    main.undeclared.map(issue => `${issue.path}: ${issue.detail}`),
    [],
    replyBreakMessage(main.undeclared),
  );
  assert.equal(
    main.stale,
    false,
    'scripts/response-compat/main.json (the main reply contract) differs from this Candidate: run npm run build:core && npm run response:main and save',
  );
});

test('incident replay 71ef0a66: the a4f1e07f -> ff527aa0 acceptedBy rename fails the main guard', async () => {
  // a4f1e07f (main) required acceptedBy.handle; ff527aa0 renamed it to the optional actor. A CLI built
  // from a4f1e07f rejected every landed reply, and no release had carried either shape.
  const root = new URL('..', import.meta.url).pathname;
  const current = await responseSnapshot(root);
  const id = 'hosted-landing#hostedLandingStateSchema';
  const a4f1e07f = z
    .object({
      kind: z.enum(['person', 'auto']),
      handle: z.string().min(1),
      at: z.iso.datetime(),
      note: z.string(),
    })
    .strict();
  const acceptance = hostedLandingStateSchema.shape.acceptance
    .unwrap()
    .extend({ acceptedBy: a4f1e07f.optional() })
    .strict();
  const base = {
    ...current,
    schemas: {
      ...current.schemas,
      [id]: z.toJSONSchema(hostedLandingStateSchema.extend({ acceptance: acceptance.optional() }), {
        io: 'input',
        unrepresentable: 'any',
      }),
    },
  };
  const issues = responseIssues(base, current, 'CLIs built from the previous main');
  assert.deepEqual(
    issues.map(issue => `${issue.path}:${issue.kind}`),
    [`${id}.acceptance.acceptedBy.handle:field-required`],
  );
  const message = replyBreakMessage(issues);
  assert.match(message, /acceptance\.acceptedBy\.handle \(field-required\)/);
  assert.match(message, /previous main/);
  assert.match(message, /for a renamed, removed or retyped field, keep the old field alongside/);
  // The fix the message names: keep the old field alongside the new optional one. Then the guard passes.
  const alongside = {
    ...current,
    schemas: {
      ...current.schemas,
      [id]: z.toJSONSchema(
        hostedLandingStateSchema.extend({
          acceptance: acceptance
            .extend({ acceptedBy: a4f1e07f.extend({ actor: z.string().min(1).optional() }).optional() })
            .optional(),
        }),
        { io: 'input', unrepresentable: 'any' },
      ),
    },
  };
  assert.deepEqual(
    responseIssues(base, alongside).map(issue => issue.path),
    [],
  );
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

test('incident replay 71ef0a66: a CLI that required acceptedBy.handle reads a landed reply after the rename', () => {
  // States 45c55f71..a4f1e07f shipped acceptedBy with a REQUIRED handle; ff527aa0 renamed it to actor,
  // so those CLIs rejected every landed reply: the final read of a wait running across that deploy.
  const firstRelease = z
    .object({
      kind: z.enum(['person', 'auto']),
      handle: z.string().min(1),
      at: z.iso.datetime(),
      note: z.string(),
    })
    .strict();
  const old = hostedLandingStateSchema.shape.acceptance
    .unwrap()
    .extend({ acceptedBy: firstRelease.optional() })
    .strict();
  const at = '2026-11-09T14:13:35.040Z';
  const reply = {
    receiptId: randomUUID(),
    head: 'b'.repeat(64),
    acceptedBy: { kind: 'auto', actor: 'thevarsek', at, note: 'Accepted automatically.' },
  };
  const strict = safeParseHostedResponse(old, reply);
  assert.equal(strict.success, false, 'the 3205f7e6 boundary alone rejects it: a required field is missing');
  assert.deepEqual(strict.error.issues.map(issue => [issue.code, issue.path.join('.')]).sort(), [
    ['invalid_type', 'acceptedBy.handle'],
    ['unrecognized_keys', 'acceptedBy'],
  ]);
  const read = parseHostedOutcome(old, z.never(), reply);
  assert.deepEqual(read.data, { receiptId: reply.receiptId, head: reply.head });
  assert.deepEqual(read.skew, { paths: ['acceptedBy.handle'], dropped: ['acceptedBy'], stable: false });
});

test('parseHostedOutcome never drops a required field and throws a reply error when nothing reads', () => {
  const schema = z
    .object({
      id: z.string(),
      state: z.enum(['open', 'done']),
      note: z.object({ n: z.number() }).strict().optional(),
    })
    .strict();
  const stable = z.object({ id: z.string() }).passthrough();
  assert.deepEqual(parseHostedOutcome(schema, stable, { id: 'a', state: 'open', extra: 1 }), {
    data: { id: 'a', state: 'open' },
  });
  const optional = parseHostedOutcome(schema, stable, { id: 'a', state: 'open', note: { n: 'x' } });
  assert.deepEqual(optional, {
    data: { id: 'a', state: 'open' },
    skew: { paths: ['note.n'], dropped: ['note'], stable: false },
  });
  const required = parseHostedOutcome(schema, stable, { id: 'a', state: 'parked' });
  assert.deepEqual(required, {
    data: { id: 'a', state: 'parked' },
    skew: { paths: ['state'], dropped: [], stable: true },
  });
  let thrown;
  try {
    parseHostedOutcome(schema, stable, { id: 1, state: 'open' });
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof z.ZodError);
  assert.equal(isHostedReplyError(thrown), true);
});
