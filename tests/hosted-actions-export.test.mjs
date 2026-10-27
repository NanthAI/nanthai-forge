import { randomUUID } from 'node:crypto';
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { actionsFixture } from './hosted-actions-fixture.mjs';
import { exportHostedActions, withHostedActionsExport } from '../dist/hosted-actions-export.js';
import { hostedActionsGit } from '../dist/hosted-actions-git.js';
import { checkPin } from '../dist/hosted-check.js';
import { code } from './hosted-checks-fixture.mjs';

test('R2 exact State export preserves binary, symlink, mode, hostile attributes and selected Blacksmith label', async () => {
  const files = [
    { path: 'binary', bytes: Buffer.from([0, 1, 254, 255]) },
    { path: 'bin/run', bytes: '#!/bin/sh\nexit 1\n', mode: 'executable' },
    { path: 'link', bytes: '../binary', mode: 'symlink' },
    { path: 'package-lock.json', bytes: '{"lockfileVersion":3}' },
    { path: '.gitattributes', bytes: '* filter=not-a-real-filter\n* text eol=crlf\n' },
    { path: '.github/workflows/forge-check.yml', bytes: 'old workflow' },
    { path: 'has spaces-ü', bytes: 'exact\r\nbytes\0' },
  ];
  const s = await actionsFixture(files),
    result = await exportHostedActions(s.input, s.transport);
  assert.notEqual(result.export.commit, s.input.request.expectedHead);
  await withHostedActionsExport(result.export, s.transport, async root => {
    for (const f of files.filter(f => !f.path.endsWith('forge-check.yml'))) {
      // cat-file output is UTF-8; use a binary file to inspect raw source bytes.
      const object = await hostedActionsGit(root, ['rev-parse', `${result.export.commit}:${f.path}`]);
      assert.match(object, /^[a-f0-9]{40}$/);
      const tree = await hostedActionsGit(root, ['ls-tree', result.export.commit, '--', f.path]);
      assert(
        tree.startsWith(f.mode === 'symlink' ? '120000' : f.mode === 'executable' ? '100755' : '100644'),
      );
    }
    const workflow = await hostedActionsGit(root, [
      'show',
      `${result.export.commit}:.github/workflows/forge-check.yml`,
    ]);
    assert(workflow.includes('runs-on: "blacksmith-4vcpu-ubuntu-2404"'));
    const plan = JSON.parse(
      await hostedActionsGit(root, ['show', `${result.export.commit}:.github/forge-check-plan.json`]),
    );
    assert.equal(plan.head, s.input.request.expectedHead);
    assert.equal(plan.pin, s.recipe.pin);
    // Compare raw Git blob IDs to hashing the original exact byte files.
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (f.path.endsWith('forge-check.yml')) continue;
      const temp = join(root, `raw-${i}`);
      await writeFile(temp, f.bytes);
      assert.equal(
        await hostedActionsGit(root, ['hash-object', '--no-filters', temp]),
        await hostedActionsGit(root, ['rev-parse', `${result.export.commit}:${f.path}`]),
      );
    }
    assert.match((await readFile(join(root, 'HEAD'))).toString(), /^ref: refs\/heads\//);
  });
  assert.equal(result.metrics.sourceFiles, files.length);
  console.log(JSON.stringify({ exportMetrics: result.metrics, storage: s.metrics }));
});
test('lost bundle upload acknowledgement rebuilds byte-identical deterministic commit and bundle', async () => {
  const s = await actionsFixture([{ path: 'a', bytes: 'source' }]),
    upload = s.transport.upload;
  let first;
  s.transport.upload = async (pin, chunks) => {
    await upload(pin, chunks);
    first = pin;
    throw new Error('lost upload');
  };
  await assert.rejects(exportHostedActions(s.input, s.transport), /lost upload/);
  s.transport.upload = upload;
  const second = await exportHostedActions(s.input, s.transport);
  assert.deepEqual(first, second.export.bundle);
  const third = await exportHostedActions(s.input, s.transport);
  assert.deepEqual(second.export, third.export);
});
test('GitHub-hosted label is generated exactly and source or lockfile corruption cannot export', async () => {
  const s = await actionsFixture([{ path: 'package-lock.json', bytes: 'pinned lock' }]);
  const input = structuredClone(s.input);
  input.configuration.runsOn = 'ubuntu-latest';
  input.request.expectedConfiguration = checkPin(input.configuration);
  const result = await exportHostedActions(input, s.transport);
  await withHostedActionsExport(result.export, s.transport, async root => {
    const workflow = await hostedActionsGit(root, [
      'show',
      `${result.export.commit}:.github/workflows/forge-check.yml`,
    ]);
    assert(workflow.includes('runs-on: "ubuntu-latest"'));
  });
  input.plan.lockfile = '0'.repeat(64);
  input.planDigest = checkPin(input.plan);
  await assert.rejects(exportHostedActions(input, s.transport), code('EVIDENCE_CHANGED'));
  const head = s.input.request.expectedHead;
  s.bytes.set(head, Buffer.from('wrong bytes'));
  await assert.rejects(exportHostedActions(s.input, s.transport), code('SOURCE_HASH_MISMATCH'));
});
test('recipe source, command, runtime, shard selection and generated-path overlap fail closed', async () => {
  const s = await actionsFixture();
  for (const mutate of [
    r => {
      r.head = '0'.repeat(64);
    },
    r => {
      r.command = ['echo', 'different'];
    },
    r => {
      r.groups = [['not-selected']];
    },
  ]) {
    const recipe = structuredClone(s.recipe);
    mutate(recipe);
    const { pin: _, ...pins } = recipe;
    recipe.pin = checkPin(pins);
    const input = structuredClone(s.input);
    input.plan.manifest = s.put(JSON.stringify(recipe));
    input.planDigest = checkPin(input.plan);
    await assert.rejects(exportHostedActions(input, s.transport), code('EVIDENCE_CHANGED'));
  }
  const input = structuredClone(s.input);
  input.configuration.runtime = '0'.repeat(64);
  await assert.rejects(exportHostedActions(input, s.transport), code('RUNNER_UNAVAILABLE'));
  const overlap = await actionsFixture([{ path: '.github', bytes: 'symlink', mode: 'symlink' }]);
  await assert.rejects(exportHostedActions(overlap.input, overlap.transport), code('EVIDENCE_CHANGED'));
});
test('large object transport stays chunked and bundle/source pins are hash checked on reuse', async () => {
  const s = await actionsFixture([{ path: 'large', bytes: Buffer.alloc(8 * 1024 * 1024, 42) }]);
  const result = await exportHostedActions(s.input, s.transport);
  assert(result.metrics.maxChunkBytes <= 8192);
  s.bytes.set(result.export.bundle.sha256, Buffer.from('corrupt'));
  await assert.rejects(
    withHostedActionsExport(result.export, s.transport, async () => {}),
    code('SOURCE_HASH_MISMATCH'),
  );
});

test('Actions covers only missing union files in the existing static job', async () => {
  const covered = 'tests/covered-contract.test.mjs';
  const s = await actionsFixture([{ path: 'package-lock.json', bytes: 'pinned lock' }]);
  const primaryIntentId = randomUUID();
  const members = [primaryIntentId, randomUUID()].map((intentId, index) => ({
    intentId,
    outcome: `Synthetic ${index}`,
    version: 1,
    tests: [{ path: index ? 'tests/missing-contract.test.mjs' : covered, durationMs: 1 }],
  }));
  assert(covered, 'fixture has a selected shard test');
  const selection = { ...s.recipe.selection, tests: [covered] };
  const { pin: _pin, ...originalRecipe } = s.recipe;
  const recipePins = { ...originalRecipe, selection, groups: [[covered]] };
  const recipe = { ...recipePins, pin: checkPin(recipePins) };
  const plan = {
    ...s.input.plan,
    shardCount: 2,
    selection: s.put(JSON.stringify(selection)),
    manifest: s.put(JSON.stringify(recipe)),
  };
  const input = { ...s.input, plan, planDigest: checkPin(plan), semanticPlan: { primaryIntentId, members } };
  const result = await exportHostedActions(input, s.transport);
  await withHostedActionsExport(result.export, s.transport, async root => {
    const workflow = await hostedActionsGit(root, [
      'show',
      `${result.export.commit}:.github/workflows/forge-check.yml`,
    ]);
    const script = `.github/forge-semantic-static-${input.id}.mjs`;
    assert(workflow.includes(`node ${script}`));
    assert.equal((workflow.match(/name: forge-static/g) ?? []).length, 1);
    const command = await hostedActionsGit(root, ['show', `${result.export.commit}:${script}`]);
    assert(command.includes('tests/missing-contract.test.mjs'));
    assert(!command.includes(covered), 'already assigned files keep their original shard execution');
  });
});
