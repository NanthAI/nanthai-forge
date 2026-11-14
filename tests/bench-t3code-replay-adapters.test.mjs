// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { replayPlan, replaySchedule, replayExpected } from '../scripts/bench-t3code/replay-schedule.mjs';
import { replayBatch, replayBatches, parseReplayKey } from '../scripts/bench-t3code/replay-cells.mjs';
import { replayAdapters } from '../scripts/bench-t3code/replay-adapters.mjs';
import {
  contributionUnion,
  resolveContributions,
  gitSource,
} from '../scripts/bench-t3code/replay-source.mjs';

test('diagnostic registration fixes five pairs, alternates arms and keeps release variants separate', () => {
  for (const kind of ['replay-clean', 'replay-conflict']) {
    const batches = replayBatches(kind);
    assert.equal(batches.length, 5);
    assert.equal(batches[0].cells[0].arm, 'github');
    assert.equal(batches[1].cells[0].arm, 'forge');
    assert.equal(batches[0].agentsAtOnce, 0);
    assert.equal(new Set(batches.map(b => b.key)).size, 5);
  }
  assert.deepEqual(parseReplayKey('replay-conflict-n10'), {
    kind: 'replay-conflict',
    release: 'late-third',
    rep: null,
  });
  assert.equal(parseReplayKey('n10-r1'), null);
  assert.notEqual(replayBatch('replay-clean', 1).seed, replayBatch('replay-conflict', 1).seed);
  assert.throws(() => replayBatch('replay-clean', 6), /Unregistered/);
});

test('synthetic recovery retains both sides, excludes diff3 base and detects unexpected source', () => {
  const allowed = new Set(['s08', 's09', 's10']);
  assert.equal(
    contributionUnion(
      '<<<<<<< lane\ns10\n||||||| base\nancestor-only\n=======\ns08\ns09\n>>>>>>> main\n',
      allowed,
    ),
    's08\ns09\ns10\n',
  );
  assert.equal(contributionUnion('<<<<<<< HEAD\ns10\n=======\ns08\n>>>>>>> main\n', allowed), 's08\ns10\n');
  assert.throws(() => contributionUnion('unknown\n', allowed), /divergence/);
  assert.throws(
    () => resolveContributions('/synthetic', ['../escape'], new Map()),
    /unexpected conflict path/,
  );
});

test('canonical Git oracle batches distinct paths at one exact head, including binary byte boundaries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-git-'));
  try {
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.name', 'synthetic');
    git('config', 'user.email', 'synthetic@example.invalid');
    writeFileSync(join(root, 'a.txt'), 's01\n');
    writeFileSync(join(root, 'b.txt'), 's02\n');
    git('add', '.');
    git('commit', '-qm', 'fixture');
    const head = git('rev-parse', 'HEAD').trim();
    writeFileSync(join(root, 'a.txt'), 'unaccepted\n');
    const source = await gitSource(root, head, ['a.txt', 'b.txt']);
    assert.equal(source.files.get('a.txt'), 's01\n');
    assert.equal(source.files.get('b.txt'), 's02\n');
    assert.equal(source.head, head);
    await assert.rejects(gitSource(root, head, ['missing.txt']), /missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Git oracle preserves the failed command diagnostic instead of masking an early exit as EPIPE', async () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-git-error-'));
  try {
    execFileSync('git', ['-C', root, 'init', '-q']);
    await assert.rejects(gitSource(root, '0'.repeat(40), ['a.txt']), error => {
      assert.equal(error.code, 'WORK_GIT_FAILED');
      assert.match(error.message, /Git ls-tree failed.*status=128/);
      return true;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function forgeFixture(plan, { badBase = false, missingReceipt = false, interrupt = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'replay-forge-')),
    records = [],
    lanes = new Map(),
    accepted = new Map(),
    events = [],
    commands = [];
  const phases = new Map(),
    identities = new Map();
  let interrupted = false;
  const forge = {
    async startLane(dir, _outcome, _prep, task, assigned) {
      if (task) identities.set(task, assigned.FORGE_AGENT_SESSION);
      mkdirSync(join(dir, '.forge'), { recursive: true });
      writeFileSync(
        join(dir, '.forge/hosted-lane.json'),
        JSON.stringify({ selection: { base: { head: badBase ? 'moved' : 'base' } } }),
      );
      if (basename(dir) === 'final-main')
        for (const [path, text] of accepted) {
          mkdirSync(join(dir, '.bench/replay'), { recursive: true });
          writeFileSync(join(dir, path), text);
        }
      return basename(dir);
    },
    async agentEnv(_root, task, assigned) {
      assert.equal(identities.get(task), assigned.FORGE_AGENT_SESSION);
      return {};
    },
    async abandon() {},
    async removeRoot() {},
  };
  const call = async command => {
    commands.push(structuredClone(command));
    const task = basename(command.root);
    const cycle = phases.get(task) ?? 0;
    if (interrupt && !interrupted) {
      interrupted = true;
      return { error: { message: 'Retry the original hosted agent action and parameters' } };
    }
    if (
      task === 's10' &&
      !plan.independent &&
      plan.release === 'late-third' &&
      ['land', 'finish'].includes(command.action) &&
      cycle < 2
    )
      return {
        result: {
          submission: { phase: 'terminal-failed' },
          recovery: { next: { action: 'sync', laneId: task } },
        },
      };
    if (command.action === 'sync') {
      const file = join(command.root, '.bench/replay/group-triple.txt');
      writeFileSync(
        file,
        `<<<<<<< lane\ns10\n||||||| base\nbase-only\n=======\n${accepted.get('.bench/replay/group-triple.txt') ?? ''}>>>>>>> main\n`,
      );
      return {
        result: {
          conflict: {
            root: command.root,
            paths: ['.bench/replay/group-triple.txt'],
            next: { action: 'resolve', laneId: task },
          },
        },
      };
    }
    if (command.action === 'resolve') {
      phases.set(task, cycle + 1);
      return { result: { applied: true, next: { action: 'land', laneId: task } } };
    }
    const t = plan.tasks.find(t => t.id === task);
    for (const edit of t.edits) {
      const lines = new Set([
        ...(accepted.get(edit.path) ?? '').trim().split('\n'),
        ...readFileSync(join(command.root, edit.path), 'utf8').trim().split('\n'),
      ]);
      lines.delete('');
      accepted.set(edit.path, [...lines].sort().join('\n') + '\n');
    }
    return {
      result: {
        submission: {
          phase: 'landed',
          acceptance: missingReceipt
            ? {}
            : {
                receiptId: 'receipt-' + task,
                head: 'head-' + task,
                acceptedBy: { at: '2026-01-01T00:00:01Z' },
              },
        },
      },
    };
  };
  const adapter = replayAdapters({
    plan,
    arm: 'forge',
    forge,
    ws: root,
    bin: root,
    base: 'base',
    forgeBase: 'base',
    records,
    lanes,
    event: e => events.push(e),
    forgeCall: call,
    sleep: async () => {},
  });
  return { adapter, root, records, events, commands, accepted, identities };
}

test('real Forge protocol drives two retained conflicts for the same late writer before one final oracle', async () => {
  const plan = replayPlan({ release: 'late-third' }),
    f = forgeFixture(plan);
  try {
    const result = await replaySchedule(plan, f.adapter, { sleep: async () => {} });
    assert.equal(result.modelTokens, 0);
    assert.equal(new Set(f.identities.values()).size, 10);
    assert.equal(result.results.length, 10);
    assert.equal(f.records.find(r => r.task === 's10').recoveries, 2);
    assert.deepEqual(f.accepted, replayExpected(plan));
    assert.equal(f.commands.filter(c => c.action === 'resolve').length, 2);
    assert.ok(f.commands.every(c => c.body.operationId));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('clean control completes with zero recovery through the same Forge adapter', async () => {
  const plan = replayPlan({ independent: true }),
    f = forgeFixture(plan);
  try {
    await replaySchedule(plan, f.adapter);
    assert.ok(f.records.every(r => r.recoveries === 0));
    assert.equal(f.accepted.size, 10);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('unknown Forge outcome retries the original operation identity', async () => {
  const plan = replayPlan({ independent: true }),
    f = forgeFixture(plan, { interrupt: true });
  try {
    const task = plan.tasks[0],
      ctx = await f.adapter.prepare(task);
    await f.adapter.stage(task, ctx);
    await f.adapter.land(task, ctx);
    assert.deepEqual(f.commands[0], f.commands[1]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('moved base and missing acceptance receipts are diagnostic divergences', async () => {
  for (const options of [{ badBase: true }, { missingReceipt: true }]) {
    const plan = replayPlan({ independent: true }),
      f = forgeFixture(plan, options);
    try {
      await assert.rejects(replaySchedule(plan, f.adapter), /preparation failed|landing failed/);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test('GitHub adapter preserves synthetic contributions through two real-protocol merge recoveries', async () => {
  const plan = replayPlan({ release: 'late-third' }),
    root = mkdtempSync(join(tmpdir(), 'replay-github-'));
  const records = [],
    events = [],
    commands = [],
    byPr = new Map(),
    reads = new Map();
  let number = 0;
  const github = {
    repository: 'synthetic/replay',
    fromGithub: x => x,
    async workspace(hub, dir) {
      mkdirSync(dir, { recursive: true });
      return {};
    },
    async gh(args) {
      commands.push(args);
      if (args[1] === 'create') {
        const task = args[args.indexOf('--head') + 1].split('/').at(-1);
        byPr.set(++number, task);
        return `https://github.com/synthetic/replay/pull/${number}\n`;
      }
      const pr = Number(args[2]),
        task = byPr.get(pr);
      if (args[1] === 'merge') return '';
      const count = reads.get(pr) ?? 0;
      reads.set(pr, count + 1);
      if (task === 's10' && count < 2)
        return JSON.stringify({ state: 'OPEN', mergeStateStatus: 'DIRTY', autoMergeRequest: {} });
      return JSON.stringify({
        state: 'MERGED',
        mergedAt: '2026-01-01T00:00:01Z',
        mergeCommit: { oid: `merged-${task}` },
      });
    },
  };
  const run = async (dir, args) => {
    const task = basename(dir);
    commands.push(args);
    if (args[0] === 'rev-parse') return 'base\n';
    if (args[0] === 'merge' && task === 's10') {
      const count = events.filter(e => e.event === 'replay-recovery' && e.task === 's10').length;
      writeFileSync(
        join(dir, '.bench/replay/group-triple.txt'),
        `<<<<<<< HEAD\ns10\n||||||| base\nbase-only\n=======\ns08\n${count ? 's09\n' : ''}>>>>>>> main\n`,
      );
      throw Error('synthetic git merge conflict');
    }
    if (args[0] === 'diff') return '.bench/replay/group-triple.txt\0';
    return '';
  };
  const adapter = replayAdapters({
    plan,
    arm: 'github',
    github,
    ws: root,
    bin: root,
    base: 'base',
    records,
    lanes: new Map(),
    run,
    sleep: async () => {},
    event: e => events.push(e),
  });
  // Final oracle is independently covered with actual Git objects above; this protocol test
  // checks real adapter argv/replies and the recovery file before any source read.
  try {
    const contexts = await Promise.all(
      plan.tasks.map(async task => {
        const ctx = await adapter.prepare(task);
        await adapter.stage(task, ctx);
        return ctx;
      }),
    );
    const results = await Promise.all(plan.tasks.map((task, i) => adapter.land(task, contexts[i])));
    assert.ok(results.every(r => r.landed));
    assert.equal(records.find(r => r.task === 's10').recoveries, 2);
    assert.equal(readFileSync(join(root, 's10/.bench/replay/group-triple.txt'), 'utf8'), 's08\ns09\ns10\n');
    assert.equal(commands.filter(a => a[0] === 'pr' && a[1] === 'create').length, 10);
    assert.ok(
      commands
        .filter(a => a[0] === 'pr' && a[1] === 'merge')
        .every(a => a.includes('--auto') && a.includes('--squash')),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing Git oracle blobs use one pack request for the whole path set', async () => {
  const calls = [];
  const a = 'a'.repeat(40),
    b = 'b'.repeat(40);
  const batch = async (_root, args, input) => {
    calls.push({ args, input });
    if (args[0] === 'ls-tree') return Buffer.from(`100644 blob ${a}\ta.txt\0` + `100644 blob ${b}\tb.txt\0`);
    if (args.includes('--batch-check')) return Buffer.from(`${a} missing\n${b} missing\n`);
    if (args[0] === 'fetch') return Buffer.from('');
    return Buffer.from(`${a} blob 4\ns01\n\n${b} blob 4\ns02\n\n`);
  };
  const source = await gitSource('/synthetic', 'head', ['a.txt', 'b.txt'], { batch });
  assert.equal(source.files.get('b.txt'), 's02\n');
  assert.deepEqual(
    calls.filter(c => c.args[0] === 'fetch').map(c => c.args),
    [['fetch', '--no-write-fetch-head', 'origin', a, b]],
  );
  assert.equal(calls.filter(c => c.args.includes('--batch')).length, 1);
});
