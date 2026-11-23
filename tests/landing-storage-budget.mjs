// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Landing storage budgets (Item 491ddd77). Every new table used to add four lines to one shared
// fixture, so most table-adding Lanes overlapped on it and paid a re-check. Each table's
// per-landing bytes now live in tests/landing-storage-budget.d/<table>.json; scenario-wide budgets
// (per-project rows, index entries, journal) stay in tests/landing-storage-budget.json. Readers get
// the same merged object as before: budgets[scenario][phase][table].
import { readdirSync, readFileSync } from 'node:fs';

export const TABLE_PHASES = ['immediate', 'retained'];
const scenarioBase = 'landing-storage-budget.json';
const tableFolder = 'landing-storage-budget.d/';

/** Tests pass synthetic locations. Each default names its exact file or folder, so the test-tree
 * scanner sees this helper list only tests/landing-storage-budget.d/, never all of tests/. */
export function readStorageBudgets(
  scenarios = new URL('./landing-storage-budget.json', import.meta.url),
  folder = new URL('./landing-storage-budget.d/', import.meta.url),
) {
  const budgets = JSON.parse(readFileSync(scenarios, 'utf8'));
  for (const [scenario, value] of Object.entries(budgets))
    for (const phase of TABLE_PHASES)
      if (value && typeof value === 'object' && phase in value)
        throw new Error(
          `tests/${scenarioBase} ${scenario}.${phase}: per-table budgets live in tests/${tableFolder}<table>.json, one file per table.`,
        );
  for (const name of readdirSync(folder).sort()) {
    if (!name.endsWith('.json'))
      throw new Error(`tests/${tableFolder}${name}: only <table>.json files belong here.`);
    const table = name.slice(0, -'.json'.length);
    const entry = JSON.parse(readFileSync(new URL(name, folder), 'utf8'));
    for (const [scenario, phases] of Object.entries(entry)) {
      if (!budgets[scenario]) throw new Error(`tests/${tableFolder}${name}: unknown scenario ${scenario}.`);
      for (const [phase, bytes] of Object.entries(phases)) {
        if (!TABLE_PHASES.includes(phase) || !Number.isSafeInteger(bytes) || bytes < 0)
          throw new Error(`tests/${tableFolder}${name}: ${scenario}.${phase} must be whole bytes.`);
        (budgets[scenario][phase] ??= {})[table] = bytes;
      }
    }
  }
  return budgets;
}
