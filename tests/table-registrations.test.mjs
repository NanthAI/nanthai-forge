// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { moduleUrl } from './convex-module.mjs';
import { ownerBoundaryFindings } from '../scripts/check-owner-boundary.mjs';
import { tableRegistrationFindings } from '../scripts/table-registrations.mjs';
import { hostedAgentHelpMarkdown } from '../dist/hosted-agent-help.js';
import { temporaryDirectory } from '../scripts/test-temp.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
const schema = (await import(moduleUrl('../convex/schema.ts'))).default;
const inventory = await import(moduleUrl('../convex/projectPurgeInventory.ts'));
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
    budgets: JSON.parse(read('tests/fixtures/landing-storage-budget.json')),
    owners: ownerBoundaryFindings(new URL('../convex/', import.meta.url)),
    helpCurrent: read('docs/agents/workflow.md').includes(hostedAgentHelpMarkdown()),
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
    'syntheticA: tests/fixtures/landing-storage-budget.json (fresh/immediate)',
    'syntheticA: tests/fixtures/landing-storage-budget.json (fresh/retained)',
    'syntheticB: docs/data-placement.md',
    'syntheticB: tests/fixtures/landing-storage-budget.json (fresh/immediate)',
    'syntheticB: tests/fixtures/landing-storage-budget.json (fresh/retained)',
    'owner-only guard: synthetic.ts:write',
    'generated help: refresh docs/agents/workflow.md with hostedAgentHelpMarkdown()',
  ]);
});

test('the combined guard reads owner registrations in place as data without executing their module', t => {
  const root = temporaryDirectory(t, 'forge-owner-inventory-');
  mkdirSync(join(root, 'convex'));
  mkdirSync(join(root, 'tests'));
  writeFileSync(
    join(root, 'convex/synthetic.ts'),
    'export const read = query({handler: async ctx => ownedProject(ctx, "synthetic")});',
  );
  const inventory = join(root, 'tests/owner-boundary-guard.test.mjs');
  const directory = pathToFileURL(join(root, 'convex') + sep);
  writeFileSync(inventory, 'throw Error("must not execute"); const allowed = { synthetic: ["read"] };');
  assert.deepEqual(ownerBoundaryFindings(directory), []);
  writeFileSync(inventory, 'const allowed = { synthetic: [] };');
  assert.match(ownerBoundaryFindings(directory)[0], /^synthetic.ts:read: classify/);
  writeFileSync(inventory, 'const allowed = computePermissions();');
  assert.throws(() => ownerBoundaryFindings(directory), /literal allowed object/);
});
