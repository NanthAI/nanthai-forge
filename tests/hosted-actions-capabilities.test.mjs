// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { directCommandSchema, directRequestSchema } from '../dist/hosted-actions-direct.js';
import {
  hostedActionsCapabilities,
  actionsCapabilityFields,
  actionsCapabilityCommands,
  actionsCommandForCapabilities,
} from '../dist/hosted-actions-capabilities.js';

// Frozen oldest supported wire fields, including nested metadata. New fields
// must have an advertised gate, applied centrally before the runner sends them.
const oldest = [
  'session.kind',
  'source.kind',
  'source.digests',
  'plan.kind',
  'plan.plan',
  'plan.plan.recipe',
  'plan.plan.recipe.pin',
  'plan.plan.recipe.head',
  'plan.plan.recipe.definition',
  'plan.plan.recipe.selection',
  'plan.plan.recipe.selection.scope',
  'plan.plan.recipe.selection.reason',
  'plan.plan.recipe.selection.tests',
  'plan.plan.recipe.groups',
  'plan.plan.recipe.standard',
  'plan.plan.recipe.interaction',
  'plan.plan.recipe.command',
  'plan.plan.lockfile',
  'output.kind',
  'output.index',
  'output.log',
  'output.log.object',
  'output.log.object.sha256',
  'output.log.object.size',
  'output.log.failureSummary',
  'result.kind',
  'result.result',
  'result.result.index',
  'result.result.exitCode',
  'result.result.log',
  'result.result.log.object',
  'result.result.log.object.sha256',
  'result.result.log.object.size',
  'result.result.log.failureSummary',
  'result.result.contractReports',
  'result.result.contractReports.*.durationMs',
  'result.result.contractReports.*.failed',
  'result.result.contractReports.*.firstError',
  'result.result.contractReports.*.flaky',
  'result.result.contractReports.*.attempts',
  'result.result.contractReports.*.attempts[].durationMs',
  'result.result.contractReports.*.attempts[].failed',
];
function fields(schema, prefix) {
  const result = [];
  for (const [key, value] of Object.entries(schema.properties ?? {})) {
    const path = `${prefix}.${key}`;
    result.push(path, ...fields(value, path));
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object')
    result.push(...fields(schema.additionalProperties, `${prefix}.*`));
  if (schema.items) result.push(...fields(schema.items, `${prefix}[]`));
  for (const variant of schema.anyOf ?? schema.oneOf ?? []) result.push(...fields(variant, prefix));
  return result;
}
function ungated(schema) {
  return schema.options.flatMap(option => {
    const json = z.toJSONSchema(option),
      kind = json.properties.kind.const;
    if (actionsCapabilityCommands[kind]) {
      assert(hostedActionsCapabilities.includes(actionsCapabilityCommands[kind]));
      return [];
    }
    assert(oldest.includes(`${kind}.kind`), `new command ${kind} needs a capability`);
    return fields(json, kind).filter(
      path =>
        !Object.keys(actionsCapabilityFields).some(
          gated => path === gated || path.startsWith(`${gated}.`) || path.startsWith(`${gated}[]`),
        ),
    );
  });
}
test('every runner request extension has a registered capability gate', () => {
  assert.deepEqual(Object.keys(directRequestSchema.shape), ['projectId', 'runId', 'fence', 'command']);
  assert.deepEqual(ungated(directCommandSchema), oldest);
  const paths = directCommandSchema.options.flatMap(option => {
    const json = z.toJSONSchema(option);
    return fields(json, json.properties.kind.const);
  });
  for (const [path, capability] of Object.entries(actionsCapabilityFields)) {
    assert(paths.includes(path), `stale capability path ${path}`);
    assert(hostedActionsCapabilities.includes(capability));
    const [kind, ...parts] = path.split('.');
    const command = { kind };
    let node = command;
    for (const part of parts.slice(0, -1)) node = node[part] = {};
    node[parts.at(-1)] = true;
    const required = Object.entries(actionsCapabilityFields)
      .filter(([parent]) => path === parent || path.startsWith(`${parent}.`))
      .map(([, capability]) => capability);
    assert.deepEqual(actionsCommandForCapabilities(command, required), command);
    const gated = actionsCommandForCapabilities(command, []);
    node = gated;
    for (const part of parts.slice(0, -1)) node = node?.[part];
    assert.equal(!!node && parts.at(-1) in node, false);
  }
  // Prove this guard catches an accidental schema addition, including nested fields.
  const added = z.discriminatedUnion(
    'kind',
    directCommandSchema.options.map(option =>
      option.shape.kind.value === 'session' ? option.extend({ accidental: z.boolean().optional() }) : option,
    ),
  );
  assert(ungated(added).includes('session.accidental'));
  assert.notDeepEqual(ungated(added), oldest);
});
test('sourcePack advertises and gates all prepare/commit request shapes', () => {
  assert(hostedActionsCapabilities.includes('sourcePack'));
  assert.equal(actionsCapabilityCommands.sourcePack, 'sourcePack');
  const schema = directCommandSchema.options.find(option => option.shape.kind.value === 'sourcePack');
  assert.deepEqual(fields(z.toJSONSchema(schema), 'sourcePack'), [
    'sourcePack.kind',
    'sourcePack.phase',
    'sourcePack.object',
    'sourcePack.object.stateRef',
    'sourcePack.object.sha256',
    'sourcePack.object.size',
    'sourcePack.object.fileCount',
  ]);
  for (const phase of ['prepare', 'commit']) {
    const command = schema.parse({
      kind: 'sourcePack',
      phase,
      object: { stateRef: 'a'.repeat(64), sha256: 'b'.repeat(64), size: 10, fileCount: 1 },
    });
    assert.throws(() => actionsCommandForCapabilities(command, []), { code: 'RUNNER_UNAVAILABLE' });
    assert.deepEqual(actionsCommandForCapabilities(command, ['sourcePack']), command);
    assert.equal(
      schema.safeParse({ ...command, object: { ...command.object, objectKey: 'unexpected' } }).success,
      false,
    );
  }
});
test('an uncaught runner refusal prints its safe reason on stderr', () => {
  const clientUrl = new URL('../dist/hosted-actions-job-client.js', import.meta.url).href;
  const program = `import { ActionsJobClient } from ${JSON.stringify(clientUrl)};
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL='https://oidc.invalid/token';
    const client = new ActionsJobClient('https://convex.invalid','synthetic','synthetic',async url =>
      String(url).startsWith('https://oidc.invalid')
        ? Response.json({value:'header.'+Buffer.from(JSON.stringify({exp:Date.now()/1000+300})).toString('base64url')+'.sig'})
        : Response.json({reason:'validation',error:'private-body'}, {status:403}));
    await client.session();`;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', program], {
    encoding: 'utf8',
    env: {},
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Convex Actions request failed \(403; reason: validation\)/);
  assert.doesNotMatch(result.stderr, /private-body/);
});
