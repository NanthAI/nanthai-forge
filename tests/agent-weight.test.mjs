// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import {
  agentBoundary,
  agentSurfaceFindings,
  baselineHash,
  weightFindings,
  readWeightBaseline,
  recordWeightEvidence,
  assertCommandWeight,
} from '../scripts/agent-weight.mjs';
import { composeFixture } from './hosted-compose-fixture.mjs';
import { controls, environment } from './hosted-source-efficiency-fixture.mjs';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';
import { moduleUrl } from './convex-module.mjs';
import { getFunctionName } from 'convex/server';
const lanes = await import(moduleUrl('../convex/projectHostedLanes.ts'));
const root = new URL('..', import.meta.url).pathname;

test('CLI/MCP weight: unchanged measurements pass; missing, oversized and extra-module measurements fail', () => {
  const baseline = readWeightBaseline(root);
  assert.deepEqual(weightFindings(baseline.ceilings, baseline), []);
  for (const [metric, max] of Object.entries(baseline.ceilings)) {
    assert.equal(weightFindings({ ...baseline.ceilings, [metric]: max + 1 }, baseline).length, 1, metric);
    assert.equal(weightFindings({ ...baseline.ceilings, [metric]: NaN }, baseline).length, 1, metric);
  }
});

test('new agent actions and runtime dependencies require an assessment against the same baseline', () => {
  const baseline = readWeightBaseline(root);
  const unchanged = { boundary: baseline.boundary, agentActions: baseline.agentActions };
  assert.deepEqual(agentSurfaceFindings(unchanged, baseline), []);
  assert.equal(
    agentSurfaceFindings(
      { ...unchanged, agentActions: [...baseline.agentActions, 'synthetic-new-action'] },
      baseline,
    ).length,
    1,
  );
  assert.equal(
    agentSurfaceFindings(
      { ...unchanged, boundary: [...baseline.boundary, 'synthetic-new-runtime'] },
      baseline,
    ).length,
    1,
  );
});

test('a changed weight baseline without a hashed reason cannot pass review evidence', t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-weight-baseline-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'tests/agent-weight-ledger'), { recursive: true });
  const baseline = JSON.parse(readFileSync(join(root, 'tests/agent-weight-baseline.json')));
  writeFileSync(join(directory, 'tests/agent-weight-baseline.json'), JSON.stringify(baseline));
  assert.throws(() => readWeightBaseline(directory), /ENOENT/);
  const ledger = join(directory, 'tests/agent-weight-ledger', `${baselineHash(baseline)}.json`);
  writeFileSync(ledger, JSON.stringify({ issue: '92dbde9d' }));
  assert.throws(() => readWeightBaseline(directory), /needs a hashed reason/);
  writeFileSync(ledger, JSON.stringify({ issue: '92dbde9d', reason: 'short' }));
  assert.throws(() => readWeightBaseline(directory), /needs a hashed reason/);
  writeFileSync(
    ledger,
    JSON.stringify({
      issue: '92dbde9d',
      reason: 'Remove UI-only dependencies; measured repeat calibration is attached.',
    }),
  );
  assert.deepEqual(readWeightBaseline(directory), baseline);
  baseline.ceilings.installedBytes++;
  writeFileSync(join(directory, 'tests/agent-weight-baseline.json'), JSON.stringify(baseline));
  assert.throws(() => readWeightBaseline(directory), /ENOENT/);
});

test('a clean merge keeps complete weight evidence from two independently recorded baseline edits', t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-weight-merge-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const baselinePath = join(directory, 'tests/agent-weight-baseline.json');
  const actions = (baseline, agentActions) => ({ ...baseline, agentActions, report: { agentActions } });
  const ceilings = (baseline, limits) => ({ ...baseline, ceilings: { ...baseline.ceilings, ...limits } });
  const base = actions({ ceilings: { installedBytes: 1000, toolListBytes: 100 } }, ['start']);
  const installed = ceilings(base, { installedBytes: 950, toolListBytes: 105 });
  const record = (baseline, parent) =>
    recordWeightEvidence(directory, baseline, '09961b44: Synthetic baseline evidence record.', parent);
  const read = baseline => {
    writeFileSync(baselinePath, JSON.stringify(baseline));
    return readWeightBaseline(directory);
  };
  record(base);
  record(installed, base);
  record(actions(base, ['inspect', 'start']), base);
  record(actions(base, ['start', 'status']), base);
  const merged = actions(installed, ['inspect', 'start', 'status']);
  assert.deepEqual(read(merged), merged);

  // An unrecorded ceiling, or a partial subset of a recorded change, still has no evidence.
  for (const toolListBytes of [106, 100])
    assert.throws(() => read(ceilings(merged, { toolListBytes })), /ENOENT/);

  // Later Lanes can branch from this merge even though it has no ledger file of its own.
  record(ceilings(merged, { installedBytes: 930 }), merged);
  record(ceilings(merged, { toolListBytes: 103 }), merged);
  const successor = ceilings(merged, { installedBytes: 930, toolListBytes: 103 });
  assert.deepEqual(read(successor), successor);

  // Sequential decisions do not authorize reviving a superseded ceiling as a clean merge.
  const raised = ceilings(successor, { installedBytes: 1100 });
  const superseded = ceilings(successor, { toolListBytes: 94 });
  record(raised, successor);
  record(superseded, raised);
  assert.throws(() => read(ceilings(superseded, { installedBytes: 1100 })), /ENOENT/);
});

test('CLI entry importing web code or a UI package fails the actual bundle boundary, including dynamic imports', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-agent-boundary-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'web'));
  writeFileSync(join(dir, 'web/screen.js'), 'console.log("synthetic web screen");');
  const bundle = async source => {
    const entry = join(dir, 'entry.mjs');
    writeFileSync(entry, source);
    return build({
      configFile: false,
      root: dir,
      logLevel: 'silent',
      plugins: [agentBoundary(dir)],
      build: { ssr: entry, write: false },
      ssr: { noExternal: true },
    });
  };
  await bundle('console.log("unchanged CLI");');
  for (const source of ['import "./web/screen.js";', 'await import("./web/screen.js");', 'import "react";'])
    await assert.rejects(bundle(source), /Agent entry imports web/);
});

test('status command reads the real Lane head at its recorded call/DB budget; an extra round trip fails', async t => {
  environment(t);
  const s = await composeFixture();
  const entry = await s.lane(s.baseline);
  const c = controls(t, s);
  const baseQuery = c.client.query;
  c.client.query = (ref, args) =>
    getFunctionName(ref) === 'projectHostedLanes:head'
      ? s.call('status-head', lanes.head, args)
      : baseQuery(ref, args);
  const state = mkdtempSync(join(tmpdir(), 'forge-status-weight-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const transport = () =>
    new HostedAgentTransport(
      join(state, 'client'),
      { url: 'https://fixture.invalid', projectId: s.projectId },
      { projectId: s.projectId, client: c.client },
    );
  const run = async extra => {
    s.counts.length = 0;
    let calls = 0;
    const query = c.client.query;
    c.client.query = async (ref, args) => {
      calls++;
      if (extra) {
        calls++;
        await query(ref, args);
      }
      return query(ref, args);
    };
    try {
      assert.equal((await transport().dispatch('status', { laneId: entry.laneId })).result.head, entry.head);
      return { calls, reads: s.counts.reduce((n, row) => n + row.documents, 0) };
    } finally {
      c.client.query = query;
    }
  };
  const unchanged = await run(false);
  t.diagnostic(JSON.stringify({ status: unchanged }));
  assertCommandWeight('status', unchanged);
  const extra = await run(true);
  assert.throws(() => assertCommandWeight('status', extra), /calls|reads/);
});
