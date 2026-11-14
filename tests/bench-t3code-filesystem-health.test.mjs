// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main as preflight } from '../scripts/bench-t3code/preflight.mjs';
import { gates, filesystemEventGate } from '../scripts/bench-t3code/gates.mjs';
import { writeCellResult } from '../scripts/bench-t3code/result.mjs';

const unhealthy = {
  ok: false,
  latencyMs: null,
  fseventsdRssMb: 2400,
  fseventsdCpuPercent: 110,
  reason: '2/3 attempts failed to deliver a filesystem event within 1000 ms',
  attempts: [{ latencyMs: null }, { latencyMs: null }, { latencyMs: 12 }],
};
const healthy = { ok: true, latencyMs: 12, fseventsdRssMb: 10, reason: null };

test('standalone bench preflight refuses before config, network probes or benchmark actions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-health-preflight-test-'));
  const lines = [];
  try {
    const code = await preflight({
      benchRoot: root,
      filesystemProbe: async target => {
        assert.equal(target, join(root, 'ws'));
        return unhealthy;
      },
      log: line => lines.push(line),
    });
    assert.equal(code, 1);
    assert.match(
      lines.join('\n'),
      /NO-GO.*ENVIRONMENT FILESYSTEM_EVENTS_UNHEALTHY.*fseventsd.*sudo killall fseventsd/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('per-cell gate refuses both arms, dry and scored, before any other start checks', async () => {
  for (const arm of ['forge', 'github'])
    for (const dry of [true, false]) {
      const result = await gates(
        { arm, dry, B: '/volume' },
        {
          filesystemProbe: async target => {
            assert.equal(target, '/volume/ws');
            return unhealthy;
          },
        },
      );
      assert.deepEqual(result.filesystemEvents, unhealthy);
      assert.equal(result.refusals.length, 1);
      assert.match(result.refusals[0], /fseventsd.*sudo killall fseventsd/);
    }
});

test('result.json retains healthy and refused event evidence and remains write-once', async () => {
  for (const probe of [healthy, unhealthy]) {
    const root = mkdtempSync(join(tmpdir(), 'forge-health-result-test-'));
    try {
      const gate = await filesystemEventGate('/volume', async () => probe);
      writeCellResult(
        root,
        { cellId: 'synthetic', gates: gate },
        gate.refusals.length ? { refused: gate.refusals.join('; ') } : { records: [] },
      );
      writeCellResult(root, {}, { overwritten: true });
      const result = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8'));
      assert.deepEqual(result.gates.filesystemEvents, probe);
      assert.equal(result.overwritten, undefined);
      assert.equal(Boolean(result.refused), !probe.ok);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('zero-model diagnostic keeps service/version gates without querying model usage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-gate-'));
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  try {
    const result = await gates(
      {
        arm: 'forge',
        N: 10,
        dry: false,
        B: root,
        flags: ['--cell', 'replay-conflict'],
        config: {
          forge: { mainBase: 'base' },
          github: { mainBase: 'base' },
          qualifiedHarness: 'harness',
          baseCheckout: root,
        },
        start: { harness: { commit: 'harness' } },
        pinProblems: async () => [],
        snapshotProblems: () => [],
        differences: () => [],
      },
      {
        filesystemProbe: async () => healthy,
        usageProbe: () => assert.fail('scripted diagnostics do not query model usage'),
        diskProbe: () => 100,
      },
    );
    assert.equal(result.usage.modelTokens, 0);
    assert.ok(result.disk.requiredGb > 0);
    assert.ok(result.refusals.includes('PLAN.md missing in BENCH_ROOT'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
