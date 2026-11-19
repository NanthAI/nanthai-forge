// SPDX-License-Identifier: Apache-2.0
// Issue ad80e037 (CLI papercuts): the retry reason has one name across the failure reply and land,
// and a preflight refused for edits made during its `nforge heavy` wait says so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { hostedAgentCommandSchemas } from '../dist/hosted-agent-contract.js';

test('ad80e037: land takes the retry reason as reason or retryReason; two different values are refused before any call', async t => {
  const s = agentFixture(t);
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  const before = s.calls.length;
  await assert.rejects(
    s
      .transport()
      .dispatch('finish', { laneId: s.lane.laneId, retry: true, reason: 'flake', retryReason: 'infra' }),
    error => error.code === 'BAD_ARGUMENT' && /as "reason"/.test(error.message),
  );
  assert.equal(s.calls.length, before, 'no call');
  // The reply's name lands the same request as the schema's name: the enqueue carries the reason.
  const enqueued = [];
  for (const command of [
    { laneId: s.lane.laneId, retry: true, retryReason: 'flake' },
    { laneId: s.lane.laneId, retry: true, reason: 'flake' },
  ]) {
    const calls = s.calls.length;
    await s.transport().dispatch('finish', { ...command, operationId: randomUUID() });
    const enqueue = s.calls.slice(calls).filter(call => call.name === 'projectHostedLanding:enqueue');
    assert.equal(enqueue.length, 1);
    enqueued.push(JSON.parse(enqueue[0].args.request).retryReason);
  }
  assert.deepEqual(enqueued, ['flake', 'flake'], 'both names enqueue the same retry reason');
  // The schema's own refusal names the field to add.
  const refused = hostedAgentCommandSchemas.finish.safeParse({ retry: true });
  assert.match(refused.error.issues[0].message, /add "reason".*next\.retryReason/);
});

test('ad80e037: a preflight refused for edits made during its heavy wait says so and names save and the same preflight', async t => {
  const s = agentFixture(t);
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  // Edited while the preflight waited: a runnable Node project the plan can read, not yet saved.
  writeFileSync(
    join(s.root, 'package.json'),
    JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }),
  );
  writeFileSync(join(s.root, 'a.test.mjs'), "import test from 'node:test'; test('a', () => {});");
  const prior = process.env.FORGE_HEAVY_PARENT;
  process.env.FORGE_HEAVY_PARENT = JSON.stringify({
    directory: '/unused',
    slot: '1',
    pid: 1,
    waitedMs: 185_000,
  });
  t.after(() =>
    prior === undefined ? delete process.env.FORGE_HEAVY_PARENT : (process.env.FORGE_HEAVY_PARENT = prior),
  );
  await assert.rejects(s.transport().dispatch('preflight', { laneId: s.lane.laneId }), error => {
    assert.equal(error.code, 'LANE_DIRTY');
    assert.match(error.message, /waited 3 min for a heavy slot; the edits came during that wait/);
    assert.match(error.message, /Save, then run the same preflight again/);
    assert.match(
      error.message,
      new RegExp(
        ` save '\\{\\}', then nforge agent .* preflight '\\{"laneId":"${s.lane.laneId}","run":true\\}'`,
      ),
    );
    return true;
  });
});

test('ad80e037: nforge heavy tells the command it runs how long it queued for its slot', t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-heavy-waited-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const settings = join(directory, 'client.json');
  writeFileSync(settings, JSON.stringify({ localHeavySlots: 1 }));
  const show = join(directory, 'show');
  writeFileSync(show, '#!/bin/sh\nprintf "%s" "$FORGE_HEAVY_PARENT"\n', { mode: 0o755 });
  const result = spawnSync(process.execPath, ['dist/cli-entry.js', 'heavy', '--no-build', show], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FORGE_HEAVY_DIR: join(directory, 'slots'),
      FORGE_CLIENT_SETTINGS: settings,
      FORGE_HEAVY_PARENT: '',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const parent = JSON.parse(result.stdout);
  assert.equal(typeof parent.waitedMs, 'number');
  assert(parent.waitedMs >= 0 && parent.waitedMs < 60_000, 'a free slot: next to no wait');
});
