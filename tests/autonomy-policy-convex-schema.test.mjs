// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { validate } from 'convex-helpers/validators';
import { moduleUrl } from './convex-module.mjs';
import { ConvexError } from 'convex/values';
import {
  autonomyPolicySchema,
  editedPolicy,
  policyPreset,
  policyWriteObject,
} from '../dist/autonomy-policy.js';

const { autonomyPolicy } = await import(moduleUrl('../convex/autonomyFields.ts'));
const { report, schemaRejection } = await import(moduleUrl('../convex/errors.ts'));

/** Every object field (at any depth) the CLI's zod schema accepts, as dotted paths, beside the Convex
 * validator's. Wrappers (optional, default, pipe) are unwrapped; unions and arrays are walked. */
const zodPaths = (schema, prefix, out) => {
  const def = schema._zod.def;
  if (['optional', 'nullable', 'default', 'prefault', 'readonly', 'nonoptional'].includes(def.type))
    return zodPaths(def.innerType, prefix, out);
  if (def.type === 'pipe') return zodPaths(def.in, prefix, out);
  if (def.type === 'array') return zodPaths(def.element, `${prefix}[]`, out);
  if (def.type === 'record') return zodPaths(def.valueType, `${prefix}{}`, out);
  if (def.type === 'union') return def.options.forEach(option => zodPaths(option, prefix, out));
  if (def.type === 'object')
    for (const [key, field] of Object.entries(def.shape)) {
      out.add(`${prefix}.${key}`);
      zodPaths(field, `${prefix}.${key}`, out);
    }
  return out;
};
const convexPaths = (validator, prefix, out) => {
  if (validator.kind === 'array') return convexPaths(validator.element, `${prefix}[]`, out);
  if (validator.kind === 'record') return convexPaths(validator.value, `${prefix}{}`, out);
  if (validator.kind === 'union')
    return validator.members.forEach(member => convexPaths(member, prefix, out));
  if (validator.kind === 'object')
    for (const [key, field] of Object.entries(validator.fields)) {
      out.add(`${prefix}.${key}`);
      convexPaths(field, `${prefix}.${key}`, out);
    }
  return out;
};

test('every policy field the CLI can write is storable in the hosted project document', () => {
  assert.deepEqual(
    Object.keys(autonomyPolicySchema.shape).filter(key => !(key in autonomyPolicy.fields)),
    [],
  );
});

test('the hosted GitHub mirror policy round-trips through the Convex validator', () => {
  const policy = editedPolicy(policyPreset('trusted'), {
    action: 'set-policy',
    operationId: crypto.randomUUID(),
    githubMirror: { repo: 'NanthAI/nanthai-forge', autoPush: true, laneRefs: false },
  });
  assert.equal(policy.githubMirror?.autoPush, true);
  assert.equal(validate(autonomyPolicy, policy), true);
});

test('guard: every nested policy field the CLI accepts (stored or set-policy) has a Convex validator field', () => {
  const stored = convexPaths(autonomyPolicy, 'policy', new Set());
  const accepted = zodPaths(autonomyPolicySchema, 'policy', new Set());
  // set-policy edits are partial forms of the stored shapes; their fields must be storable too.
  const envelope = new Set(['action', 'governanceVersion', 'operationId', 'expectedPolicy']);
  for (const [key, field] of Object.entries(policyWriteObject.shape)) {
    if (envelope.has(key)) continue;
    accepted.add(`policy.${key}`);
    zodPaths(field, `policy.${key}`, accepted);
  }
  assert.ok(accepted.has('policy.agentDefaults.stacking'), 'the walk reaches nested agentDefaults');
  assert.deepEqual(
    [...accepted].filter(path => !stored.has(path)),
    [],
  );
});

test('a Convex schema rejection reaches the CLI as HOSTED_SCHEMA_REJECTED with the field, not the value', () => {
  const message =
    'Failed to insert or update a document in table "hostedProjects" because it does not match the schema: ' +
    'Object contains extra field `stacking` that is not in the validator.\nPath: .autonomyPolicy.agentDefaults\n' +
    'Object: {stacking: "auto", privateValue: "do-not-echo"}\nValidator: v.object({autoClaim: v.optional(v.boolean())})';
  const data = schemaRejection(message);
  assert.equal(data.code, 'HOSTED_SCHEMA_REJECTED');
  assert.equal(data.field, 'hostedProjects.autonomyPolicy.agentDefaults.stacking');
  assert.match(data.message, /hostedProjects\.autonomyPolicy\.agentDefaults\.stacking/);
  assert.doesNotMatch(data.message, /do-not-echo|auto"/);
  assert.throws(
    () => report(new Error(message)),
    error => error instanceof ConvexError && error.data.code === 'HOSTED_SCHEMA_REJECTED',
  );
  assert.equal(schemaRejection('Some other failure'), undefined);
  assert.throws(
    () => report(new Error('Some other failure')),
    error => error instanceof ConvexError && error.data.code === 'HOSTED_REQUEST_FAILED',
  );
});
