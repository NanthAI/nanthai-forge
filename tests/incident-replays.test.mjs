// SPDX-License-Identifier: Apache-2.0
// Regression ladder rung 3 guard: every registered incident replay stays a live test in the
// normal suite, and the ladder doc lists every incident. Static reads only, well under 1 s.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const registry = JSON.parse(readFileSync('tests/fixtures/incident-replays.json', 'utf8'));
const LADDER = 'docs/agents/regression-ladder.md';
/** Incidents the ladder requires (45f49fb7): B1.5d case studies and core-claim incidents. */
const REQUIRED = ['n3-r3-a1', 't27456', 'a930de4c', 'c329d191', 'a7de3a93'];

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Problems for one entry; `read` returns a file's source or null when missing. */
function replayProblems(entry, read) {
  if (!/^tests\/[^/]+\.test\.mjs$/.test(entry.file))
    return [`${entry.incident}: ${entry.file} is outside the normal suite (tests/*.test.mjs)`];
  const source = read(entry.file);
  if (source === null) return [`${entry.incident}: ${entry.file} is missing`];
  // The title as written (quote, backtick or template), directly in a plain test( call.
  const call = new RegExp(`\\btest(\\.\\w+)?\\(\\s*(['"\`])${escape(entry.test)}\\2([^\\n]*)`);
  const match = source.match(call);
  if (!match) return [`${entry.incident}: no test titled "${entry.test}" in ${entry.file}`];
  if (match[1] || /\b(skip|todo)\s*:/.test(match[3]))
    return [`${entry.incident}: "${entry.test}" is skipped, todo or only (${match[1] ?? 'option'})`];
  return [];
}
const readRepo = path => (existsSync(path) ? readFileSync(path, 'utf8') : null);

test('every registered incident replay is a live test in the normal suite', () => {
  assert.equal(registry.schema, 1);
  assert.deepEqual(
    registry.replays.flatMap(entry => replayProblems(entry, readRepo)),
    [],
  );
});

test('every required incident has a replay and the ladder doc names each incident', () => {
  const incidents = new Set(registry.replays.map(entry => entry.incident));
  for (const id of REQUIRED) assert(incidents.has(id), `${id} has a replay`);
  const doc = readFileSync(LADDER, 'utf8');
  for (const id of incidents) assert(doc.includes(`\`${id}\``), `${LADDER} names ${id}`);
  assert(doc.includes('tests/fixtures/incident-replays.json'), 'the doc points at the registry');
});

test('guard fixture: a renamed, skipped or moved replay fails the guard', () => {
  const entry = { incident: 'c329d191', file: 'tests/x.test.mjs', test: 'incident c329d191: replay' };
  const read = source => path => (path === 'tests/x.test.mjs' ? source : null);
  assert.deepEqual(replayProblems(entry, read(`test('incident c329d191: replay', () => {});`)), []);
  assert.deepEqual(replayProblems(entry, read(`test(\n  'incident c329d191: replay',\n  t => {});`)), []);
  // The incident's replay was renamed away (the failure this guard exists for).
  assert.match(replayProblems(entry, read(`test('something else', () => {});`))[0], /no test titled/);
  assert.match(
    replayProblems(entry, read(`test.skip('incident c329d191: replay', () => {});`))[0],
    /skipped/,
  );
  assert.match(
    replayProblems(entry, read(`test('incident c329d191: replay', { skip: true }, () => {});`))[0],
    /skipped/,
  );
  assert.match(replayProblems(entry, read(null))[0] ?? '', /missing/);
  assert.match(
    replayProblems({ ...entry, file: 'tests/fixtures/x.mjs' }, read(''))[0],
    /outside the normal suite/,
  );
});
