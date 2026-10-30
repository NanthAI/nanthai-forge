// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';
const { proposalCandidates } = await import(moduleUrl('../web/src/proposal-api.ts'));
const { ProposalProvenance } = await import(moduleUrl('../web/src/ProjectProposals.tsx'));
const { captureHostedPair, downloadHostedPair } = await import(moduleUrl('../web/src/hosted-handoff.ts'));
const previousWindow = globalThis.window;
globalThis.window = { location: { hash: '' } };
if (previousWindow === undefined) delete globalThis.window;
else globalThis.window = previousWindow;

test('proposal selection keeps exact clean Views for the original Intent base; conflicts and other work stay separate', () => {
  const intentId = randomUUID(),
    baseState = 'a'.repeat(64),
    pin = { intentId, baseState },
    first = { id: randomUUID(), intentId, base: baseState, head: 'b'.repeat(64), status: 'clean' },
    second = { ...first, id: randomUUID(), head: 'c'.repeat(64) };
  const views = [
    first,
    { ...first, status: 'conflict' },
    { ...first, intentId: randomUUID() },
    { ...first, base: 'd'.repeat(64) },
    { ...first, head: undefined },
    null,
    second,
  ];
  assert.deepEqual(proposalCandidates({ views }, pin), [
    { id: first.id, head: first.head },
    { id: second.id, head: second.head },
  ]);
  assert.deepEqual(proposalCandidates({ views: [] }, pin), []);
  assert.deepEqual(proposalCandidates(null, pin), []);
});

test('actual proposal provenance renderer keeps exact pins and literal actor text without promoting evidence to authority', () => {
  const proposal = {
      operationId: randomUUID(),
      intentId: randomUUID(),
      baseState: 'a'.repeat(64),
      head: 'b'.repeat(64),
      viewId: randomUUID(),
      digest: 'c'.repeat(64),
      actor: '<script>unknown actor</script>',
      _id: 'synthetic-proposal',
    },
    projectKey = randomUUID();
  const html = renderToStaticMarkup(createElement(ProposalProvenance, { proposal, projectKey }));
  for (const pin of [
    proposal.baseState,
    proposal.head,
    proposal.viewId,
    proposal.digest,
    projectKey,
    proposal.operationId,
  ])
    assert.ok(html.includes(pin));
  assert.match(html, /&lt;script&gt;unknown actor&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /contributor-supplied claims/);
  assert.match(html, /separate Lane/);
  assert.match(html, /import-native-contribution/);
});

test('proposal handoff uses restored hosted Work and offers isolated source import', () => {
  const proposal = {
    operationId: randomUUID(),
    intentId: randomUUID(),
    baseState: 'a'.repeat(64),
    head: 'b'.repeat(64),
    viewId: randomUUID(),
    digest: 'c'.repeat(64),
    actor: 'user_contributor',
    _id: 'synthetic-proposal',
  };
  const html = renderToStaticMarkup(
    createElement(ProposalProvenance, { proposal, projectKey: randomUUID() }),
  );
  assert.match(html, /restored source and Work pair containing this Intent/);
  assert.match(html, /import-native-contribution/);
  assert.ok(html.includes(proposal.digest));
  assert.doesNotMatch(html, /reconcile-hosted-work|Work reconciliation request/);
});

test('source return between either download preserves one exact journal/archive pair and explicit refresh selects a new pair', async () => {
  const hash = bytes => createHash('sha256').update(bytes).digest('hex'),
    original = Buffer.from('Original common archive'),
    newer = Buffer.from('Returned common archive');
  const snapshot = {
    key: randomUUID(),
    name: 'Synthetic Forge',
    backupId: 'old-archive',
    backupDigest: hash(original),
    sourceHead: 'a'.repeat(64),
    sourceKind: 'native',
  };
  const makeJournal = (id, bytes, revision) =>
    JSON.stringify({
      kind: 'forge-hosted-work-journal',
      projectKey: snapshot.key,
      revision,
      base: { archiveSha256: hash(bytes) },
      source: { backupId: id, head: 'b'.repeat(64), kind: 'native' },
      events: [{ action: 'intent', text: 'Unicode 🛠' }],
    });
  let current = makeJournal('new-archive', newer, 21),
    reads = 0;
  const readJournal = async () => {
    reads++;
    return current;
  };
  const pair = await captureHostedPair(snapshot, readJournal),
    retainedJournal = pair.journal;
  assert.equal(pair.archive.id, 'new-archive');
  assert.equal(pair.journalSha256, hash(Buffer.from(retainedJournal)));
  current = makeJournal('later-archive', Buffer.from('Later return'), 23); // Canonical source changes after pair capture and before/between chunk reads.
  const calls = [],
    progress = [];
  const downloaded = await downloadHostedPair(
    pair,
    async input => {
      calls.push(input);
      assert.equal(input.id, 'new-archive');
      assert.equal(input.digest, hash(newer));
      const bytes = newer.subarray(input.offset, input.offset + 5);
      return {
        data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        size: newer.length,
        digest: hash(newer),
      };
    },
    (received, total) => progress.push([received, total]),
  );
  assert.deepEqual(Buffer.from(await downloaded.blob.arrayBuffer()), newer);
  assert.ok(calls.length > 1);
  assert.equal(pair.journal, retainedJournal);
  assert.equal(
    reads,
    1,
    'The matching journal download reuses captured bytes rather than reading a newer journal.',
  );
  assert.deepEqual(progress.at(-1), [newer.length, newer.length]);
  const next = await captureHostedPair(snapshot, readJournal);
  assert.equal(next.archive.id, 'later-archive');
  assert.equal(next.revision, 23);
  assert.equal(pair.revision, 21);
  await assert.rejects(
    downloadHostedPair(pair, async () => ({
      data: newer.buffer.slice(newer.byteOffset, newer.byteOffset + newer.length),
      size: newer.length,
      digest: '0'.repeat(64),
    })),
    /differs from the retained Work journal/,
  );
});

test('older journal metadata pairs only an identical snapshot digest; a concurrent source return never guesses an archive', async () => {
  const snapshot = {
    key: randomUUID(),
    name: 'Synthetic',
    backupId: 'old',
    backupDigest: 'a'.repeat(64),
    sourceHead: 'b'.repeat(64),
    sourceKind: 'native',
  };
  const journal = digest =>
    JSON.stringify({
      kind: 'forge-hosted-work-journal',
      projectKey: snapshot.key,
      revision: 2,
      base: { archiveSha256: digest },
    });
  assert.equal(
    (await captureHostedPair(snapshot, async () => journal(snapshot.backupDigest))).archive.id,
    'old',
  );
  await assert.rejects(
    captureHostedPair(snapshot, async () => journal('c'.repeat(64))),
    /Hosted source changed/,
  );
});
