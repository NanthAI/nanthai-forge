// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { moduleUrl } from './convex-module.mjs';
import { ownerBoundaryFindings } from '../scripts/check-owner-boundary.mjs';
import { tableRegistrationFindings } from '../scripts/table-registrations.mjs';
import { hostedAgentHelpMarkdown } from '../dist/hosted-agent-help.js';
import { temporaryDirectory } from '../scripts/test-temp.mjs';
import { readStorageBudgets } from './landing-storage-budget.mjs';
import { readDocument } from '../scripts/package-documents.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const schema = (await import(moduleUrl('../convex/schema.ts'))).default;
const inventory = await import(moduleUrl('../convex/projectPurgeInventory.ts'));
const repo = fileURLToPath(new URL('..', import.meta.url));
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('new tables report all five registration gaps together before a landing check is spent', () => {
  const findings = tableRegistrationFindings({
    tables: Object.entries(schema.tables).map(([name, table]) => ({
      name,
      projectOwned:
        inventory.idPaths(name, 'hostedProjects').length > 0 || 'projectId' in (table.validator.fields ?? {}),
    })),
    placement: read('docs/data-placement.md'),
    purge: new Set([
      ...Object.keys(inventory.projectPurgeTables),
      ...Object.keys(inventory.projectPurgeSpecial),
    ]),
    budgets: readStorageBudgets(),
    owners: ownerBoundaryFindings(new URL('../convex/', import.meta.url)),
    helpCurrent: readDocument(repo, 'docs/agents/workflow.md').includes(hostedAgentHelpMarkdown()),
  });
  assert.deepEqual(findings, [], `Complete all missing registrations:\n${findings.join('\n')}`);
});

test('one diagnostic includes every omitted table, budget phase, owner classification and generated help', () => {
  const gaps = tableRegistrationFindings({
    tables: [
      { name: 'syntheticA', projectOwned: true },
      { name: 'syntheticB', projectOwned: false },
    ],
    placement: '',
    purge: new Set(),
    budgets: { fresh: { immediate: {}, retained: {} } },
    owners: ['synthetic.ts:write'],
    helpCurrent: false,
  });
  assert.deepEqual(gaps, [
    'syntheticA: docs/data-placement.md',
    'syntheticA: convex/projectPurgeInventory.ts',
    'syntheticA: tests/landing-storage-budget.d/syntheticA.json (fresh/immediate)',
    'syntheticA: tests/landing-storage-budget.d/syntheticA.json (fresh/retained)',
    'syntheticB: docs/data-placement.md',
    'syntheticB: tests/landing-storage-budget.d/syntheticB.json (fresh/immediate)',
    'syntheticB: tests/landing-storage-budget.d/syntheticB.json (fresh/retained)',
    'owner-only guard: synthetic.ts:write',
    'generated help: refresh docs/agents/workflow.d/sections/0310-generated-contract.md with hostedAgentHelpMarkdown()',
  ]);
});

test('the combined guard reads owner registrations as data, one file per module, without executing the guard', t => {
  const root = temporaryDirectory(t, 'forge-owner-inventory-');
  mkdirSync(join(root, 'convex'));
  mkdirSync(join(root, 'tests/owner-boundary-guard.d'), { recursive: true });
  writeFileSync(
    join(root, 'convex/synthetic.ts'),
    'export const read = query({handler: async ctx => ownedProject(ctx, "synthetic")});',
  );
  const guard = join(root, 'tests/owner-boundary-guard.test.mjs');
  const entry = join(root, 'tests/owner-boundary-guard.d/synthetic.json');
  const directory = pathToFileURL(join(root, 'convex') + sep);
  writeFileSync(guard, 'throw Error("must not execute");');
  writeFileSync(entry, '{"actions": ["read"], "reason": "Read-only."}');
  assert.deepEqual(ownerBoundaryFindings(directory), []);
  writeFileSync(entry, '{"actions": []}');
  assert.match(ownerBoundaryFindings(directory)[0], /^synthetic.ts:read: classify/);
  writeFileSync(entry, '{"actions": "read"}');
  assert.throws(() => ownerBoundaryFindings(directory), /synthetic\.json: must be/);
  // A permission map added back to the shared guard file is refused, so entries keep their own files.
  writeFileSync(entry, '{"actions": ["read"]}');
  writeFileSync(guard, 'const allowed = { synthetic: ["read"] };');
  assert.throws(() => ownerBoundaryFindings(directory), /one file per module/);
  // The folder is the only input: no caller can hand the guard its own permission map.
  assert.equal(ownerBoundaryFindings.length, 1);
  writeFileSync(guard, 'throw Error("must not execute");');
  // A Finder .DS_Store in the folder is not an entry.
  writeFileSync(join(root, 'tests/owner-boundary-guard.d/.DS_Store'), '\0binary');
  assert.deepEqual(ownerBoundaryFindings(directory), []);
  // An entry for a deleted module is stale: it would revive if a module of that name came back.
  writeFileSync(join(root, 'tests/owner-boundary-guard.d/removed.json'), '{"actions": ["write"]}');
  assert.deepEqual(ownerBoundaryFindings(directory), [
    'tests/owner-boundary-guard.d/removed.json: convex/removed.ts no longer exists; delete the stale entry',
  ]);
});
