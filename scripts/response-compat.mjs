// SPDX-License-Identifier: Apache-2.0
// Old CLI vs new server (Issue 3205f7e6). A CLI parses hosted replies with parseHostedResponse
// (src/hosted-response.ts): unknown keys are dropped, everything else must match. So a server
// change is safe for released CLIs when every reply the new contract allows is still accepted by
// the released contract once unknown keys are ignored. This compares the two as JSON Schema.
// Docs: docs/operations/cli-update.md "Server replies".
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { compareSnapshots, undeclaredChanges } from './schema-compat.mjs';

export const responseSnapshotPath = 'scripts/response-compat/released.json';
/** The reply contract of the current main, kept equal to the source by `npm run response:main`. */
export const responseMainPath = 'scripts/response-compat/main.json';
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

/** Changes that would make an older CLI reject a reply the candidate contract allows.
 * `who` names the baseline: the released CLI, or a CLI built from the previous main. */
export function responseIssues(released, current, who = 'released CLIs') {
  if (released?.unknownKeys !== 'strip') throw new Error('Response snapshot must say unknownKeys: strip');
  // Reversed on purpose: the RELEASED schema must accept everything the CURRENT one allows.
  return compareSnapshots(open(current), open(released))
    .filter(
      // A field or reply the released CLI does not know is dropped (or never asked for).
      issue => !['field-removed', 'schema-removed'].includes(issue.kind),
    )
    .map(issue => ({
      ...issue,
      detail: `${who} would reject this reply: ${reasons[issue.kind] ?? issue.detail}`,
    }));
}
const reasons = {
  'field-required': 'they require a field the new contract may omit',
  'enum-narrowed': 'the new contract allows a value they do not know',
  'type-narrowed': 'the new contract allows a type they do not accept',
  'constraint-narrowed': 'they enforce a tighter limit',
  'constraint-changed': 'a format, pattern or combinator changed',
};

const sorted = value =>
  Array.isArray(value)
    ? value.map(sorted)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map(key => [key, sorted(value[key])]),
        )
      : value;
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
export const mainBaseline = 'CLIs built from the previous main';

/** The message a failing reply-contract landing check prints: each field path and the fix. */
export function replyBreakMessage(undeclared, baseline = mainBaseline) {
  const fix = JSON.stringify(
    undeclared.map(({ path, change }) => ({ path, change, reason: 'feature-gated: NAME' })),
  );
  return (
    `${baseline} would reject replies this Candidate allows: ` +
    `${undeclared.map(issue => `${issue.path} (${issue.kind})`).join('; ')}. ` +
    `Fix: make a field you newly require optional; for a renamed, removed or retyped field, keep the old ` +
    `field alongside the new one (or answer the old shape unless the client advertises a feature of ` +
    `src/hosted-contract-features.ts), ` +
    `then declare a deliberate change in scripts/response-compat/declared.json: ${fix}`
  );
}

/** Candidate vs the release baseline and the current-main baseline. `main.stale` is true when
 * main.json no longer equals the Candidate's own contract (run `npm run response:main`). */
export async function checkResponseCompatibility(root) {
  const read = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
  const current = await responseSnapshot(root);
  const declared = read(responseDeclaredPath);
  const issues = responseIssues(read(responseSnapshotPath), current);
  const main = read(responseMainPath);
  const mainIssues = responseIssues(main, current, mainBaseline);
  return {
    issues,
    undeclared: undeclaredChanges(issues, declared),
    main: {
      issues: mainIssues,
      undeclared: undeclaredChanges(mainIssues, declared),
      stale: !same(main.schemas, current.schemas),
    },
  };
}
