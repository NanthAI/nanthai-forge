// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { fixtureFiles } from './sustained-plan.mjs';

/** Score exact fixture bytes from a pinned State, independently of the runner verdict. */
export function sustainedVerdict(plan, files) {
  const present = new Set();
  for (const task of plan.tasks)
    if (files.has(`bench-workload/submissions/${task.id}.txt`)) present.add(task.id);
  const expected = fixtureFiles(plan, present);
  const mismatches = [...new Set([...files.keys(), ...expected.keys()])].filter(
    path => files.get(path) !== expected.get(path),
  );
  const soloReds = plan.tasks.filter(task => task.soloRed && present.has(task.id)).map(task => task.id);
  const evaluatedPairs = plan.pairs.filter(pair => pair.members.every(id => present.has(id)));
  const jointReds = evaluatedPairs.filter(pair => pair.jointRed).map(pair => pair.id);
  return {
    present: [...present],
    mismatches,
    soloReds,
    jointReds,
    evaluatedPairs: evaluatedPairs.map(pair => pair.id),
    green: mismatches.length + soloReds.length + jointReds.length === 0,
  };
}

/** Render the tiny candidate-side test. It reads its own files and emits a named failure
 * only after the shard ran, so infrastructure failures can never count as planted reds. */
export function sustainedCheckScript(plan) {
  const rules = {
    soloReds: plan.tasks.filter(task => task.soloRed).map(task => task.id),
    jointReds: plan.pairs.filter(pair => pair.jointRed).map(pair => pair.members),
    shardMs: plan.shardMs,
  };
  return `import { readdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
const rules = ${JSON.stringify(rules)};
const part = process.env.FORGE_CHECK_PART;
if (part === 'static') process.exit(0);
if (part !== 'tests' || process.env.FORGE_CHECK_SHARD_TOTAL !== '2')
  throw Error('BENCH_SHARD_COUNT_MISMATCH');
const index = Number(process.env.FORGE_CHECK_SHARD_INDEX);
if (index !== 1 && index !== 2) throw Error('BENCH_SHARD_INDEX_MISMATCH');
const folder = 'bench-workload/submissions';
let names;
try {
  names = readdirSync(folder);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  names = [];
}
const present = new Set(names.map(name => name.slice(0, -4)));
if (rules.shardMs > 0) await sleep(rules.shardMs);
const failures = [
  ...rules.soloReds.filter(id => present.has(id)).map(id => ['SOLO', id]),
  ...rules.jointReds.filter(pair => pair.every(id => present.has(id))).map(pair => ['JOINT', pair.join('+')]),
];
for (const [kind, id] of failures) {
  const shard = Math.floor(Number(id.slice(1, 3)) / 4) % 2 + 1;
  if (shard !== index) continue;
  console.log(\`BENCH_\${kind}_RED \${id}\`);
  process.exitCode = 1;
}
`;
}
