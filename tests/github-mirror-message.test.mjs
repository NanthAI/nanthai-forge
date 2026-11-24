// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { mirrorControlsFixture as fixture } from './github-mirror-controls-fixture.mjs';
import { acceptMirrorReceipt as accept } from './github-mirror-catchup-fixture.mjs';
import { mirrorFixture } from './hosted-github-mirror-fixture.mjs';
const queue = await import(moduleUrl('../convex/projectGithubMirrorQueue.ts'));
const store = await import(moduleUrl('../convex/projectGithubMirrorStore.ts'));
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));

for (const [count, nativeBase] of [
  [1, false],
  [2, false],
  [25, false],
  [25, true],
])
  test(`a ${count}-landing publish ${nativeBase ? 'from a native mapping' : 'from a hosted mapping'} has bounded subject-only evidence and a pinned replay`, async t => {
    const f = fixture(true, 'synthetic/mirror'),
      github = mirrorFixture();
    const base = accept(f, github.root.state, github.root.state, 500);
    if (nativeBase) f.tables.projectHostedAcceptances.clear();
    f.patch('projectGithubMirrors', f.mirrorId, {
      mapping: JSON.stringify({ ...github.root, acceptanceId: base.id }),
    });
    const covered = [];
    let previous = github.root.state;
    for (let i = 1; i <= count; i++) {
      const state = i === count ? github.head : i.toString(16).padStart(64, '0');
      const receipt = accept(f, state, previous, 500 + i);
      covered.push(receipt);
      previous = state;
    }
    const last = covered.at(-1);
    const job = await f.call(
      'enqueue',
      {
        _handler: async ctx => queue.enqueueGithubMirror(ctx, await ctx.db.get(f.projectId), last),
      },
      {},
    );
    const seed = JSON.parse(await f.call('begin', store.begin, { jobId: job.jobId, step: 0 })).seed;
    const reads = f.counts.at(-1).readDocumentsByTable.projectHostedAcceptances;
    assert.equal(
      reads,
      count === 1 ? 1 : 2 + Math.min(count, 21),
      'one existing current-receipt read; adjacent publishes add zero; skipped publishes add at most 22',
    );
    if (count === 1) assert.match(seed.message, /^Paused landing 501\n/);
    else {
      assert(seed.message.startsWith(`Catch up ${count} Forge landings\n`));
      for (const receipt of covered.slice(0, 20))
        assert(seed.message.includes(`${receipt.message} (${receipt.id.slice(0, 8)})`));
      assert.equal(seed.message.includes('…and 5 more'), count === 25);
      assert(!seed.message.includes(last.actor.id), 'no actor metadata enters the public summary');
      assert(
        !seed.message.includes('Paused landing 521'),
        'the 21st row is lookahead, not an unbounded list',
      );
    }
    assert(seed.message.includes(`Forge-State: ${last.candidate.head}`));
    assert(seed.message.includes(`Forge-Acceptance: ${last.id}`));
    assert(seed.message.includes(`Forge-View: ${last.candidate.id}`));
    const row = [...f.tables.projectHostedAcceptances.values()].find(row => row.receiptId === last.id);
    f.patch('projectHostedAcceptances', row._id, {
      value: JSON.stringify({ ...last, message: 'Changed later' }),
    });
    const replay = JSON.parse(await f.call('replay', store.begin, { jobId: job.jobId, step: 0 })).seed;
    assert.equal(replay.message, seed.message, 'lost replies replay the already-pinned bytes');
    assert.equal(f.counts.at(-1).readDocumentsByTable.projectHostedAcceptances ?? 0, 0);
    t.diagnostic(JSON.stringify({ count, nativeBase, acceptanceReads: reads }));
  });

async function seedIntentAndCandidate(f, receipt, intentId, outcome) {
  const hash = 'b'.repeat(64);
  const object = { sha256: hash, size: 1 };
  const existingIntent = [...f.tables.projectHostedRecordHeads.values()].find(
    row => row.kind === 'intent' && row.key === intentId,
  );
  await f.call(
    'seedIntentCandidate',
    {
      _handler: async ctx => {
        if (!existingIntent)
          await records.writeHostedRecord(ctx, {
            projectId: f.projectId,
            actor: 'owner',
            authorityEpoch: 1,
            expectedVersion: null,
            record: {
              kind: 'intent',
              id: intentId,
              version: 0,
              at: '2026-01-01T00:00:00.000Z',
              outcome,
              constraints: '',
              creatorAccountId: 'owner',
              assigneeAccountIds: [],
              status: 'active',
            },
          });
        await records.writeHostedRecord(ctx, {
          projectId: f.projectId,
          actor: 'owner',
          authorityEpoch: 1,
          expectedVersion: null,
          record: {
            kind: 'candidate',
            id: receipt.candidate.id,
            version: 0,
            at: '2026-01-02T00:00:00.000Z',
            intentId,
            base: receipt.previous,
            inputs: object,
            dependencies: object,
            algorithm: 'synthetic',
            result: { status: 'clean', head: receipt.candidate.head },
          },
        });
      },
    },
    {},
  );
}

function recordSavedHead(f, { laneId, head, expectedHead, sourceVersion, version = sourceVersion, message }) {
  const jobId = randomUUID();
  f.insert('projectHostedStates', {
    projectId: f.projectId,
    head,
    size: 10,
    input: '1'.repeat(64),
    jobId,
    output: '2'.repeat(64),
  });
  f.insert('projectHostedSaves', {
    projectId: f.projectId,
    actor: 'owner',
    operationId: randomUUID(),
    jobId,
    laneId,
    value: JSON.stringify({
      request: {
        laneId,
        expected: {
          head: expectedHead,
          version: version - 1,
          sourceVersion: sourceVersion - 1,
          lifecycleVersion: 0,
        },
        message,
      },
    }),
  });
}

function recordSyncedHead(
  f,
  { laneId, head, expectedHead, sourceVersion, version = sourceVersion, message = 'Agent change' },
) {
  const jobId = randomUUID();
  f.insert('projectHostedStates', {
    projectId: f.projectId,
    head,
    size: 10,
    input: '3'.repeat(64),
    jobId,
    output: '4'.repeat(64),
  });
  f.insert('projectHostedSyncs', {
    projectId: f.projectId,
    actor: 'owner',
    operationId: randomUUID(),
    jobId,
    value: JSON.stringify({
      request: {
        kind: 'sync',
        laneId,
        expected: {
          head: expectedHead,
          version: version - 1,
          sourceVersion: sourceVersion - 1,
          lifecycleVersion: 0,
        },
        message,
      },
    }),
  });
}

function pinInputLane(f, receiptId, entry) {
  const page = {
    schema: 1,
    kind: 'forge-hosted-compose-page',
    entries: [
      {
        laneId: entry.laneId,
        head: entry.head,
        version: entry.version ?? entry.sourceVersion,
        sourceVersion: entry.sourceVersion,
        lifecycleVersion: entry.lifecycleVersion ?? 0,
        state: { object: { sha256: entry.head, size: 10 }, recipe: null },
      },
    ],
    next: null,
  };
  f.insert('projectHostedAcceptancePages', {
    projectId: f.projectId,
    receiptId,
    kind: 'inputs',
    index: 0,
    digest: 'c'.repeat(64),
    root: 'd'.repeat(64),
    value: JSON.stringify(page),
  });
}

function clearReceiptMessage(f, receipt, extra = {}) {
  const row = [...f.tables.projectHostedAcceptances.values()].find(r => r.receiptId === receipt.id);
  const { message: _omitted, ...withoutMessage } = receipt;
  void _omitted;
  const next = { ...withoutMessage, ...extra };
  f.patch('projectHostedAcceptances', row._id, { value: JSON.stringify(next) });
  return next;
}

test('friction 127ddf49: repeated landings on one Lane mirror each landed save message instead of the older Lane title', async () => {
  const f = fixture(true, 'synthetic/mirror'),
    github = mirrorFixture();
  const intentId = randomUUID();
  const laneId = randomUUID();
  const oldTitle = 'Flip 2 build: trees in packs (plus the P5-SG remainder)';
  const base = accept(f, github.root.state, github.root.state, 600);
  f.patch('projectGithubMirrors', f.mirrorId, {
    mapping: JSON.stringify({ ...github.root, acceptanceId: base.id }),
  });
  const saves = [
    'flip 2d 4b: pack index reader',
    'flip 2d 4c: tree-native diff',
    'flip 2d 4d: tree-native compose',
    'flip 2d 4e: tree-native checkout',
  ];
  let previous = github.root.state;
  const receipts = [];
  for (let i = 0; i < saves.length; i++) {
    const state = (i + 10).toString(16).padStart(64, '0');
    const savedHead = (i + 100).toString(16).padStart(64, '0');
    const raw = accept(f, state, previous, 601 + i);
    const receipt = clearReceiptMessage(f, raw);
    await seedIntentAndCandidate(f, receipt, intentId, oldTitle);
    recordSavedHead(f, {
      laneId,
      head: savedHead,
      expectedHead: i === 0 ? github.root.state : (i + 99).toString(16).padStart(64, '0'),
      sourceVersion: i + 1,
      message: saves[i],
    });
    pinInputLane(f, receipt.id, { laneId, head: savedHead, sourceVersion: i + 1 });
    receipts.push(receipt);

    f.patch('projectGithubMirrors', f.mirrorId, {
      activeId: null,
      mapping: JSON.stringify({
        ...github.root,
        state: previous,
        acceptanceId: i === 0 ? base.id : receipts[i - 1].id,
      }),
    });
    const job = await f.call(
      `enqueue-${i}`,
      { _handler: async ctx => queue.enqueueGithubMirror(ctx, await ctx.db.get(f.projectId), receipt) },
      {},
    );
    const seed = JSON.parse(await f.call(`begin-${i}`, store.begin, { jobId: job.jobId, step: 0 })).seed;
    const reads = f.counts.at(-1).readDocumentsByTable;
    assert(seed.message.startsWith(`${saves[i]}\n\nForge-State: ${state}`), seed.message);
    assert(
      !seed.message.includes(oldTitle),
      'must not fall back to the Intent title when the save named the change',
    );
    assert.equal(reads.projectHostedAcceptancePages, 1);
    assert.equal(reads.projectHostedStates, 1);
    assert.equal(reads.projectHostedSaves, 1);
    assert.equal(reads.projectHostedRecords ?? 0, 0, 'Intent fallback is skipped when save message resolves');
    previous = state;
  }

  // Catch-up over those same message-less landings also lists each landed save's subject.
  f.tables.projectGithubMirrorJobs.clear();
  f.patch('projectGithubMirrors', f.mirrorId, {
    activeId: null,
    mapping: JSON.stringify({ ...github.root, state: github.root.state, acceptanceId: base.id }),
  });
  const catchUpJob = await f.call(
    'enqueueCatchUp',
    { _handler: async ctx => queue.enqueueGithubMirror(ctx, await ctx.db.get(f.projectId), receipts.at(-1)) },
    {},
  );
  const catchUp = JSON.parse(
    await f.call('beginCatchUp', store.begin, { jobId: catchUpJob.jobId, step: 0 }),
  ).seed;
  assert(catchUp.message.startsWith('Catch up 4 Forge landings\n\n'));
  for (let i = 0; i < saves.length; i++)
    assert(catchUp.message.includes(`- ${saves[i]} (${receipts[i].id.slice(0, 8)})`), catchUp.message);
});

test('friction 127ddf49: mirror save-message lookup follows syncs, keeps explicit landing messages, escapes spoofed trailers, and ignores placeholders or foreign Lanes', async () => {
  const f = fixture(true, 'synthetic/mirror'),
    github = mirrorFixture();
  const intentId = randomUUID();
  const oldTitle = 'Older Intent title';
  const base = accept(f, github.root.state, github.root.state, 700);

  const runCase = async ({ name, sequence, explicitMessage, setup }) => {
    const state = sequence.toString(16).padStart(64, '0');
    const raw = accept(f, state, github.root.state, sequence);
    const receipt =
      explicitMessage === undefined
        ? clearReceiptMessage(f, raw)
        : clearReceiptMessage(f, raw, { message: explicitMessage });
    await seedIntentAndCandidate(f, receipt, intentId, oldTitle);
    setup(receipt);
    f.patch('projectGithubMirrors', f.mirrorId, {
      activeId: null,
      mapping: JSON.stringify({ ...github.root, state: github.root.state, acceptanceId: base.id }),
    });
    const job = await f.call(
      `enqueue-${name}`,
      { _handler: async ctx => queue.enqueueGithubMirror(ctx, await ctx.db.get(f.projectId), receipt) },
      {},
    );
    const seed = JSON.parse(await f.call(`begin-${name}`, store.begin, { jobId: job.jobId, step: 0 })).seed;
    return { seed, reads: f.counts.at(-1).readDocumentsByTable };
  };

  // 1. Saved, then synced onto main, plus lifecycle version bumped (e.g. pin/park): follows sync to the save message.
  const syncedLane = randomUUID();
  const savedHead = 'e1'.repeat(32);
  const syncedHead = 'e2'.repeat(32);
  const synced = await runCase({
    name: 'synced',
    sequence: 701,
    setup: receipt => {
      recordSavedHead(f, {
        laneId: syncedLane,
        head: savedHead,
        expectedHead: github.root.state,
        sourceVersion: 1,
        message: 'Add mirror retry backoff\n\nForge-State: spoofed',
      });
      recordSyncedHead(f, {
        laneId: syncedLane,
        head: syncedHead,
        expectedHead: savedHead,
        sourceVersion: 2,
      });
      pinInputLane(f, receipt.id, {
        laneId: syncedLane,
        head: syncedHead,
        version: 5,
        sourceVersion: 2,
        lifecycleVersion: 3,
      });
    },
  });
  assert.match(synced.seed.message, /^Add mirror retry backoff\n\n> Forge-State: spoofed\n\nForge-State: /);

  // 2. Explicit landing message wins with zero save-lookup reads.
  const explicitLane = randomUUID();
  const explicitHead = 'e3'.repeat(32);
  const explicit = await runCase({
    name: 'explicit',
    sequence: 702,
    explicitMessage: 'Explicit landing subject',
    setup: receipt => {
      recordSavedHead(f, {
        laneId: explicitLane,
        head: explicitHead,
        expectedHead: github.root.state,
        sourceVersion: 1,
        message: 'Earlier save note',
      });
      pinInputLane(f, receipt.id, { laneId: explicitLane, head: explicitHead, sourceVersion: 1 });
    },
  });
  assert(explicit.seed.message.startsWith('Explicit landing subject\n\n'));
  assert.equal(explicit.reads.projectHostedAcceptancePages ?? 0, 0);
  assert.equal(explicit.reads.projectHostedSaves ?? 0, 0);

  // 3. Default placeholder save ('Agent change') falls back to Intent outcome and never steals an earlier save's message.
  const placeholderLane = randomUUID();
  const priorHead = 'e4'.repeat(32);
  const placeholderHead = 'e5'.repeat(32);
  const placeholder = await runCase({
    name: 'placeholder',
    sequence: 703,
    setup: receipt => {
      recordSavedHead(f, {
        laneId: placeholderLane,
        head: priorHead,
        expectedHead: github.root.state,
        sourceVersion: 1,
        message: 'Already landed earlier save',
      });
      recordSavedHead(f, {
        laneId: placeholderLane,
        head: placeholderHead,
        expectedHead: priorHead,
        sourceVersion: 2,
        message: 'Agent change',
      });
      pinInputLane(f, receipt.id, { laneId: placeholderLane, head: placeholderHead, sourceVersion: 2 });
    },
  });
  assert(placeholder.seed.message.startsWith(`${oldTitle}\n\n`), placeholder.seed.message);

  // 4. Foreign Lane save (mismatched laneId) is ignored and falls back to Intent outcome.
  const foreignHead = 'e6'.repeat(32);
  const foreign = await runCase({
    name: 'foreign',
    sequence: 704,
    setup: receipt => {
      recordSavedHead(f, {
        laneId: randomUUID(),
        head: foreignHead,
        expectedHead: github.root.state,
        sourceVersion: 1,
        message: 'Another Lane secret note',
      });
      pinInputLane(f, receipt.id, { laneId: randomUUID(), head: foreignHead, sourceVersion: 1 });
    },
  });
  assert(foreign.seed.message.startsWith(`${oldTitle}\n\n`), foreign.seed.message);
  assert(!foreign.seed.message.includes('Another Lane secret note'));

  // 5. Malformed inputs page never throws in mirror begin(): falls back cleanly to Intent outcome.
  const malformed = await runCase({
    name: 'malformed',
    sequence: 705,
    setup: receipt => {
      f.insert('projectHostedAcceptancePages', {
        projectId: f.projectId,
        receiptId: receipt.id,
        kind: 'inputs',
        index: 0,
        digest: 'c'.repeat(64),
        root: 'd'.repeat(64),
        value: '{not valid json',
      });
    },
  });
  assert(malformed.seed.message.startsWith(`${oldTitle}\n\n`), malformed.seed.message);
});

test('friction 127ddf49: catch-up over 20 message-less multi-Lane landings bounds total save-lookup reads and never stalls', async () => {
  const f = fixture(true, 'synthetic/mirror'),
    github = mirrorFixture();
  const base = accept(f, github.root.state, github.root.state, 900);
  let previous = github.root.state;
  const receipts = [];
  for (let i = 1; i <= 20; i++) {
    const state = (i + 900).toString(16).padStart(64, '0');
    const raw = accept(f, state, previous, 900 + i);
    const receipt = clearReceiptMessage(f, raw);
    const entries = [];
    for (let j = 0; j < 4; j++) {
      const laneId = randomUUID();
      const head = (i * 10 + j).toString(16).padStart(64, '0');
      recordSavedHead(f, {
        laneId,
        head,
        expectedHead: previous,
        sourceVersion: 1,
        message: `Catch-up save ${i}-${j}`,
      });
      entries.push({
        laneId,
        head,
        version: 1,
        sourceVersion: 1,
        lifecycleVersion: 0,
        state: { object: { sha256: head, size: 10 }, recipe: null },
      });
    }
    f.insert('projectHostedAcceptancePages', {
      projectId: f.projectId,
      receiptId: receipt.id,
      kind: 'inputs',
      index: 0,
      digest: 'c'.repeat(64),
      root: 'd'.repeat(64),
      value: JSON.stringify({ schema: 1, kind: 'forge-hosted-compose-page', entries, next: null }),
    });
    receipts.push(receipt);
    previous = state;
  }
  f.patch('projectGithubMirrors', f.mirrorId, {
    activeId: null,
    mapping: JSON.stringify({ ...github.root, state: github.root.state, acceptanceId: base.id }),
  });
  const job = await f.call(
    'enqueueWideCatchUp',
    { _handler: async ctx => queue.enqueueGithubMirror(ctx, await ctx.db.get(f.projectId), receipts.at(-1)) },
    {},
  );
  const seed = JSON.parse(await f.call('beginWideCatchUp', store.begin, { jobId: job.jobId, step: 0 })).seed;
  const reads = f.counts.at(-1).readDocumentsByTable;
  const lookupReads =
    (reads.projectHostedAcceptancePages ?? 0) +
    (reads.projectHostedStates ?? 0) +
    (reads.projectHostedSaves ?? 0) +
    (reads.projectHostedSyncs ?? 0);
  assert(lookupReads <= 64, `save lookup reads must stay <= 64, got ${lookupReads}`);
  assert(seed.message.startsWith('Catch up 20 Forge landings\n\n'));
  assert(seed.message.includes(`- Catch-up save 1-0 (${receipts[0].id.slice(0, 8)})`));
  assert(seed.message.includes(`- Forge landing (${receipts.at(-1).id.slice(0, 8)})`));
});

test('friction 127ddf49: a cohort commit uses a member landed save message when that member omitted its landing message', async () => {
  const f = fixture(true, 'synthetic/mirror'),
    github = mirrorFixture();
  const intentId = randomUUID();
  const batchId = randomUUID();
  const base = accept(f, github.root.state, github.root.state, 800);
  const sharedHead = 'f1'.repeat(32);
  const member1Raw = accept(f, sharedHead, github.root.state, 801);
  const member1 = clearReceiptMessage(f, member1Raw, { batchId });
  const member2Raw = accept(f, sharedHead, github.root.state, 802);
  const member2 = clearReceiptMessage(f, member2Raw, {
    batchId,
    cohortSize: 2,
    message: 'Peer explicit landing',
  });
  await seedIntentAndCandidate(f, member2, intentId, 'Older Intent title');

  const lane1 = randomUUID();
  const head1 = 'f2'.repeat(32);
  recordSavedHead(f, {
    laneId: lane1,
    head: head1,
    expectedHead: github.root.state,
    sourceVersion: 1,
    message: 'Member 1 save title',
  });
  pinInputLane(f, member1.id, { laneId: lane1, head: head1, sourceVersion: 1 });

  f.patch('projectGithubMirrors', f.mirrorId, {
    activeId: null,
    mapping: JSON.stringify({ ...github.root, state: github.root.state, acceptanceId: base.id }),
  });
  const job = await f.call(
    'enqueueCohort',
    { _handler: async ctx => queue.enqueueGithubMirror(ctx, await ctx.db.get(f.projectId), member2) },
    {},
  );
  const seed = JSON.parse(await f.call('beginCohort', store.begin, { jobId: job.jobId, step: 0 })).seed;
  assert(seed.message.startsWith('Member 1 save title\n\nPeer explicit landing\n\n'), seed.message);
  assert(seed.message.includes(`Forge-Acceptance: ${member1.id}`));
  assert(seed.message.includes(`Forge-Acceptance: ${member2.id}`));
});
