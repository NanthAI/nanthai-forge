// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Regression ladder rung 3 guard: every registered incident replay stays a live test in the
// normal suite, and the ladder doc lists every incident. Static reads only, well under 1 s.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const registry = JSON.parse(readFileSync('tests/fixtures/incident-replays.json', 'utf8'));
const LADDER = 'docs/agents/regression-ladder.md';
/** Incidents the ladder requires (45f49fb7): B1.5d case studies and core-claim incidents. */
const REQUIRED = ['n3-r3-a1', 't27456', 'a930de4c', 'c329d191', 'a7de3a93', '19328518', '238b3573'];

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

test('a registered core file whose replay only loads its module loses its proof', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const probe = (call, todo = false) =>
    spawnSync(
      process.execPath,
      [
        '--import',
        './tests/check-runtime.mjs',
        '--input-type=module',
        '--eval',
        `
        import test from 'node:test';
        import { watchIncidentReplays } from './tests/incident-replay-runtime.mjs';
        watchIncidentReplays([{ file: 'probe', test: 'probe', paths: ['src/landing-attempt-timing.ts'] }]);
        test('probe', async t => {
          const { readAttemptLocks } = await import('./dist/landing-attempt-timing.js');
          ${call ? "readAttemptLocks({ directory: process.env.TMPDIR }, 'unused');" : ''}
          ${todo ? "t.todo('deferred');" : ''}
        });
      `,
      ],
      { env, encoding: 'utf8' },
    );
  const called = probe(true);
  assert.equal(called.status, 0, called.stderr);
  const imported = probe(false);
  assert.equal(imported.status, 1, imported.stderr);
  assert.match(imported.stderr, /no longer reaches src\/landing-attempt-timing\.ts/);
  const deferred = probe(true, true);
  assert.equal(deferred.status, 1, deferred.stderr);
  assert.match(deferred.stderr, /skipped or marked TODO/);
});

test('Guard 4 (6abdde40): a core queue change runs every registered replay, the queue simulation and the cost guard', async () => {
  const { coreQueueTests } = await import('../scripts/core-queue-paths.mjs');
  const fixed = [
    'tests/core-queue-paths.test.mjs',
    'tests/hosted-landing-queue-sim.test.mjs',
    'tests/incident-replays.test.mjs',
    'tests/landing-cost-guard.test.mjs',
  ];
  const listed = registry.replays.map(entry => entry.file);
  // Every listed file exists (the first test), so the guard set is the whole registry, never fewer.
  const files = new Map([...fixed, ...listed].filter(path => existsSync(path)).map(path => [path, '']));
  files.set('tests/fixtures/incident-replays.json', JSON.stringify(registry));
  assert.deepEqual(coreQueueTests(files), [...new Set([...fixed, ...listed])].sort());
});
