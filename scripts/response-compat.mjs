// SPDX-License-Identifier: Apache-2.0
// Old CLI vs new server (Issue 3205f7e6). A CLI parses hosted replies with parseHostedResponse
// (src/hosted-response.ts): unknown keys are dropped, everything else must match. So a server
// change is safe for released CLIs when every reply the new contract allows is still accepted by
// the released contract once unknown keys are ignored. This compares the two as JSON Schema.
// Docs: docs/agents/hosted-parity.md "Response contract".
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { compareSnapshots, undeclaredChanges } from './schema-compat.mjs';

export const responseSnapshotPath = 'scripts/response-compat/released.json';
export const responseDeclaredPath = 'scripts/response-compat/declared.json';
/** Exported reply schemas the CLI parses through parseHostedResponse ([dist module, export]). */
export const responseSchemas = [
  ['hosted-agent-contract', 'hostedAgentCapabilitiesSchema'],
  ['hosted-lane', 'hostedStartResultSchema'],
  ['hosted-lane', 'hostedLaneSelectionSchema'],
  ['hosted-main', 'hostedMainV2Schema'],
  ['hosted-main', 'hostedMainSchema'],
  ['hosted-sync', 'syncResultSchema'],
  ['hosted-save', 'saveResultSchema'],
  ['hosted-check', 'hostedCheckRunSchema'],
  ['hosted-source-authority', 'sourceAuthoritySchema'],
  ['hosted-board', 'boardDeliverySchema'],
  ['hosted-landing', 'hostedLandingStateSchema'],
  ['hosted-finish', 'hostedFinishSchema'],
];

/** The current build's reply contract (needs dist/). Accepted input, as JSON Schema. */
export async function responseSnapshot(root, version) {
  const schemas = {};
  for (const [module, name] of responseSchemas) {
    const schema = (await import(pathToFileURL(resolve(root, 'dist', `${module}.js`)).href))[name];
    if (!(schema instanceof z.ZodType)) throw new Error(`dist/${module}.js#${name} is not a Zod schema`);
    schemas[`${module}#${name}`] = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  }
  return { format: 1, ...(version ? { version } : {}), unknownKeys: 'strip', schemas };
}

/** Unknown keys are dropped at the reply boundary, so closed objects compare as open ones. */
const open = value =>
  Array.isArray(value)
    ? value.map(open)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([key, item]) => !(key === 'additionalProperties' && item === false))
            .map(([key, item]) => [key, open(item)]),
        )
      : value;

/** Changes that would make a released CLI reject a reply the candidate contract allows. */
export function responseIssues(released, current) {
  if (released?.unknownKeys !== 'strip')
    throw new Error('Released response snapshot must say unknownKeys: strip');
  // Reversed on purpose: the RELEASED schema must accept everything the CURRENT one allows.
  return compareSnapshots(open(current), open(released))
    .filter(
      // A field or reply the released CLI does not know is dropped (or never asked for).
      issue => !['field-removed', 'schema-removed'].includes(issue.kind),
    )
    .map(issue => ({
      ...issue,
      detail: `released CLIs would reject this reply: ${reasons[issue.kind] ?? issue.detail}`,
    }));
}
const reasons = {
  'field-required': 'they require a field the new contract may omit',
  'enum-narrowed': 'the new contract allows a value they do not know',
  'type-narrowed': 'the new contract allows a type they do not accept',
  'constraint-narrowed': 'they enforce a tighter limit',
  'constraint-changed': 'a format, pattern or combinator changed',
};

export async function checkResponseCompatibility(root) {
  const read = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
  const issues = responseIssues(read(responseSnapshotPath), await responseSnapshot(root));
  return { issues, undeclared: undeclaredChanges(issues, read(responseDeclaredPath)) };
}
