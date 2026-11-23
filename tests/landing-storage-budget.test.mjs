// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Per-table landing storage budgets (Item 491ddd77): one file per table so table-adding Lanes no
// longer overlap on one shared fixture; readers keep budgets[scenario][phase][table].
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readStorageBudgets } from './landing-storage-budget.mjs';
import { temporaryDirectory } from '../scripts/test-temp.mjs';

function fixture(t, base, tables) {
  const root = temporaryDirectory(t, 'forge-storage-budget-');
  mkdirSync(join(root, 'landing-storage-budget.d'));
  writeFileSync(join(root, 'landing-storage-budget.json'), JSON.stringify(base));
  for (const [name, entry] of Object.entries(tables))
    writeFileSync(join(root, 'landing-storage-budget.d', name), JSON.stringify(entry));
  return [
    pathToFileURL(join(root, 'landing-storage-budget.json')),
    pathToFileURL(join(root, 'landing-storage-budget.d') + '/'),
  ];
}

test('per-table budget files merge into the scenario budgets readers index by table', t => {
  const root = fixture(
    t,
    { fresh: { indexes: { before: { entries: 1 } } }, dogfood: {}, journal: { fresh: {} } },
    {
      'tableB.json': { fresh: { immediate: 5, retained: 0 }, dogfood: { immediate: 7, retained: 2 } },
      'tableA.json': { fresh: { immediate: 0, retained: 3 } },
    },
  );
  assert.deepEqual(readStorageBudgets(...root), {
    fresh: {
      indexes: { before: { entries: 1 } },
      immediate: { tableA: 0, tableB: 5 },
      retained: { tableA: 3, tableB: 0 },
    },
    dogfood: { immediate: { tableB: 7 }, retained: { tableB: 2 } },
    journal: { fresh: {} },
  });
});

test('a per-table budget added to the shared scenario file fails and names the per-table folder', t => {
  const root = fixture(t, { fresh: { immediate: { newTable: 10 } } }, {});
  assert.throws(
    () => readStorageBudgets(...root),
    /fresh\.immediate: per-table budgets live in tests\/landing-storage-budget\.d\/<table>\.json/,
  );
  const typo = fixture(t, { fresh: {} }, { 'tableA.json': { fersh: { immediate: 1 } } });
  assert.throws(() => readStorageBudgets(...typo), /unknown scenario fersh/);
  const fraction = fixture(t, { fresh: {} }, { 'tableA.json': { fresh: { immediate: 1.5 } } });
  assert.throws(() => readStorageBudgets(...fraction), /must be whole bytes/);
});
