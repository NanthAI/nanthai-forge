// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { waitEventLine } from '../dist/hosted-wait-line.js';

// Issue 47558a99: a queued landing used to print the whole submission, queue and cursor on every wake.
const sha = 'a'.repeat(64);
const event = ({ queue, ...over } = {}) => ({
  type: 'submission',
  id: randomUUID(),
  operationId: 'op-1',
  version: 4,
  submission: {
    id: randomUUID(),
    projectId: 'project',
    phase: 'queued',
    version: 4,
    observation: { state: 'pending', pendingReason: 'queued' },
    request: {
      head: sha,
      base: sha,
      tests: Array.from({ length: 40 }, (_, i) => `tests/file-${i}.test.mjs`),
    },
    timing: { submittedAt: '2026-01-01T00:00:00.000Z' },
  },
  queue: {
    position: 7,
    total: 8,
    entriesAhead: 6,
    groupsAhead: 6,
    predecessor: { id: randomUUID(), phase: 'checking', lastProgressAt: '2026-01-01T00:00:00.000Z' },
    eta: { milliseconds: 600000, approximate: true, basis: 'recent-service' },
    message: 'Queued position 7 of 8; 6 ahead.',
    ...queue,
  },
  terminal: false,
  ok: false,
  cursor: 'c'.repeat(600),
  ...over,
});

test('a queued wake becomes one short line with the decision facts', () => {
  const full = event();
  const { line } = waitEventLine(full);
  assert.deepEqual(
    { ...line, version: undefined },
    {
      type: 'submission',
      operationId: 'op-1',
      phase: 'queued',
      state: 'pending',
      reason: 'queued',
      position: 7,
      ahead: 6,
      total: 8,
      landingState: 'queued',
      terminal: false,
      ok: false,
      version: undefined,
    },
  );
  const sizes = [JSON.stringify(full).length, JSON.stringify(line).length];
  t_diagnostic(sizes);
  assert(sizes[1] < 220 && sizes[1] * 8 < sizes[0], `compact line ${sizes[1]} of ${sizes[0]} chars`);
});
const t_diagnostic = sizes => console.log(`# queued event ${sizes[0]} chars -> line ${sizes[1]} chars`);

test('a wake that changed only the clock, version or cursor has the same key', () => {
  const a = waitEventLine(event());
  const b = waitEventLine(
    event({
      version: 5,
      cursor: 'd'.repeat(600),
      queue: { eta: { milliseconds: 540000, approximate: true, basis: 'recent-service' }, message: 'later' },
    }),
  );
  assert.equal(a.key, b.key);
  assert.notEqual(a.key, waitEventLine(event({ queue: { position: 6, entriesAhead: 5 } })).key);
});

test('terminal outcomes, conflicts and failures keep their facts', () => {
  const landed = event({ terminal: true, ok: true });
  landed.submission.phase = 'landed';
  landed.submission.observation = { state: 'landed' };
  assert.deepEqual(
    (({ phase, state, terminal, ok }) => ({ phase, state, terminal, ok }))(waitEventLine(landed).line),
    { phase: 'landed', state: 'landed', terminal: true, ok: true },
  );
  const failed = event({ terminal: true, wouldConflict: { paths: ['a'] }, recovery: { command: 'x' } });
  failed.submission.error = { code: 'COMPOSITION_CONFLICT', message: 'long' };
  const { line } = waitEventLine(failed);
  assert.equal(line.error, 'COMPOSITION_CONFLICT');
  assert.deepEqual(line.wouldConflict, { paths: ['a'] });
  assert.deepEqual(line.recovery, { command: 'x' });
});

test('run snapshots and retry notes keep scalars only', () => {
  const { line } = waitEventLine({
    id: 'run',
    projectId: 'p',
    status: 'running',
    files: [{ a: 1 }],
    request: 'x',
  });
  assert.deepEqual(line, { type: 'run', id: 'run', status: 'running' });
  assert.equal(waitEventLine({ type: 'observation-retry' }).line.type, 'observation-retry');
});

// Incident 19328518: a passed entry parked behind an older submission names it on its line.
test('wait line: a parked READY entry names the older submission it waits for', () => {
  const older = randomUUID();
  const parked = event({ queue: null, orderWait: { submissionId: older, message: 'Check passed; waiting' } });
  parked.submission.phase = 'ready';
  const { line } = waitEventLine(parked);
  assert.equal(line.waitingFor, older);
  assert.equal(line.phase, 'ready');
  assert.equal('waitingFor' in waitEventLine(event()).line, false, 'no wait, no field');
});

// Issue 7cb61db1: a scoped-mode plan that ran the whole command says why on the landing's wait line.
test('wait line: a check that ran in full names its reason; a scoped one adds nothing', () => {
  const reason = 'Command scope: package graph: gradle: …; declare packages.commands in forge.json; full run';
  const full = event();
  full.submission.ranInFull = reason;
  assert.equal(waitEventLine(full).line.ranInFull, reason);
  assert.notEqual(waitEventLine(full).key, waitEventLine(event()).key, 'the reason prints once');
  assert.equal('ranInFull' in waitEventLine(event()).line, false);
});
