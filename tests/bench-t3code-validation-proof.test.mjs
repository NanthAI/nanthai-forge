// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { temporaryDirectory } from '../scripts/test-temp.mjs';
import { coordinationBatch } from '../scripts/bench-t3code/cells.mjs';
import {
  queueSettings,
  validationEvidence,
  validationRegistration,
  validationSelection,
} from '../scripts/bench-t3code/validation-proof.mjs';

test('the close validation records both queue configurations, pinned source and original cell evidence', t => {
  const root = temporaryDirectory(t, 'release-validation-');
  const release = 'a'.repeat(40);
  const state = 'b'.repeat(64);
  const batch = coordinationBatch('overlap', 8, 1);
  const start = {
    at: '2026-11-26T20:00:00Z',
    githubMain: release,
    harness: { commit: release, filesSha256: 'script-digest' },
    cli: { git: release, commit: state },
    deploy: { databaseId: 12, headSha: release },
    convexTree: { deploy: 'backend-tree' },
    checkWorkflow: { forge: 'forge-workflow', github: 'github-workflow' },
  };
  const forge = { preset: 'trusted', acceptance: { admissionCheck: 'queue-only' } };
  const github = {
    id: 9,
    name: 'b15d-main',
    enforcement: 'active',
    rules: [
      { type: 'merge_queue', parameters: { grouping_strategy: 'HEADGREEN', max_entries_to_merge: 10 } },
      {
        type: 'required_status_checks',
        parameters: { required_status_checks: [{ context: 'bench-check' }] },
      },
    ],
  };
  const queues = queueSettings(forge, github);
  const plan = { planSha256: 'plan-digest', design: { tasksSha256: 'tasks-digest' } };
  const config = { forge: { mainBase: 'base' } };
  validationSelection(release, batch.key, false);
  assert.throws(() => validationSelection(release, 'n3-r1', true), /scored batch/);
  const register = pins => validationRegistration(release, batch, pins, plan, config, queues);
  assert.throws(() => register({ ...start, githubMain: 'c'.repeat(40) }), /registered CLI, mirror, harness/);
  assert.throws(() => queueSettings(forge, { ...github, rules: [] }), /both arms/);
  const registration = register(start);
  assert.equal(registration.kind, 'release-validation');
  assert.equal(registration.series, 'release-aaaaaaaaaaaa');
  assert.equal(registration.releaseState, state);
  assert.equal(registration.source.deployment.runId, 12);
  assert.equal(registration.queues.forge.acceptance.admissionCheck, 'queue-only');
  assert.equal(registration.queues.github.mergeQueue.grouping_strategy, 'HEADGREEN');
  assert.deepEqual(
    registration.cells.map(cell => cell.stacking),
    [null, 'offer', 'auto'],
  );
  const cells = registration.cells.map((cell, i) => ({
    key: cell.key,
    cellId: i < 2 ? cell.slot + '-attempt1' : null,
    voided: i === 0 ? [] : ['stopped'],
  }));
  for (const cell of cells.slice(0, 2)) {
    const dir = join(root, 'runs', cell.cellId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'samples.jsonl'), '{"load":[1,2,3]}\n');
    if (!cell.voided.length) writeFileSync(join(dir, 'result.json'), '{"landed":8}\n');
  }
  const evidence = validationEvidence(root, cells);
  assert.equal(evidence.registration, 'validation.json');
  assert.equal(evidence.cells[0].result, 'runs/github-attempt1/result.json');
  assert.equal(evidence.cells[1].samples, 'runs/forge-offer-attempt1/samples.jsonl');
  assert.equal(evidence.cells[1].result, null);
  assert.deepEqual(evidence.cells[1].voided, ['stopped']);
  assert.equal(evidence.cells[2].samples, null);
});
