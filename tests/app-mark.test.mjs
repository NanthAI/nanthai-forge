// SPDX-License-Identifier: Apache-2.0
// The top-bar F follows the live line feed (Item 641d887b): priorities, one-shots once per event (never on the first
// read, a re-render or a repeated delivery), the failed and landed holds, and calming down.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';

const { baseMark, markMemory, observe, shownMark, markMotion, CALM_MS, STILL_MS } = await import(
  moduleUrl('../web/src/app/mark.ts')
);

const lane = (laneId, stage, extra = {}) => ({
  laneId,
  stage,
  held: false,
  overlap: false,
  changedAt: 1,
  ...extra,
});
const feed = (lanes, exit = null, more = 0) => ({ lanes, more, moreIsLowerBound: false, main: null, exit });
const run = (...feeds) => {
  const memory = markMemory();
  feeds.forEach((value, index) => observe(memory, value, index * 1000));
  return memory;
};

test('standing priority: landing > waiting > conflict > checks > working, many > working > idle', () => {
  assert.equal(baseMark(undefined), 'idle');
  assert.equal(baseMark(feed([])), 'idle');
  assert.equal(baseMark(feed([lane('a', 'editing')])), 'w1');
  assert.equal(baseMark(feed([lane('a', 'editing')], null, 1)), 'wN');
  assert.equal(baseMark(feed([lane('a', 'checking'), lane('b', 'editing')])), 'checks');
  // Item 9b9057a9: a saved file shared with another Lane is no conflict; a held Lane's exact conflict is.
  assert.equal(baseMark(feed([lane('a', 'checking'), lane('b', 'saved', { overlap: true })])), 'checks');
  assert.equal(
    baseMark(feed([lane('a', 'checking'), lane('b', 'saved', { held: true, fix: true, overlap: true })])),
    'overlap',
  );
  assert.equal(
    baseMark(feed([lane('a', 'saved', { held: true }), lane('b', 'saved', { overlap: true })])),
    'waiting',
  );
  assert.equal(baseMark(feed([lane('a', 'ready'), lane('b', 'saved', { held: true })])), 'landing');
  // Issue f5c4d136: a hold on the Lane's own next step (failed check, conflict) is agent work, not a person's turn.
  assert.equal(baseMark(feed([lane('a', 'saved', { held: true, fix: true })])), 'w1');
  assert.equal(
    baseMark(feed([lane('a', 'saved', { held: true, fix: true }), lane('b', 'saved', { held: true })])),
    'waiting',
  );
});

test('the first read of a project never replays its last exit', () => {
  const memory = run(feed([], { laneId: 'old', kind: 'landed', at: 5 }));
  assert.deepEqual(shownMark(memory, 0), { state: 'idle' });
});

test('a Lane that leaves Checking held did not take: failed for 10 s, then the standing state', () => {
  const memory = run(feed([lane('a', 'checking')]), feed([lane('a', 'saved', { held: true, changedAt: 2 })]));
  assert.equal(shownMark(memory, 1000 + 9_999).state, 'failed');
  assert.equal(shownMark(memory, 1000 + 9_999).until, 11_000);
  assert.equal(shownMark(memory, 11_000).state, 'waiting');
});

test('one-shots fire once per event: a re-render or the same event delivered again does not replay it', () => {
  const failing = [feed([lane('a', 'checking')]), feed([lane('a', 'saved', { held: true, changedAt: 2 })])];
  const memory = run(...failing);
  const first = memory.shot;
  observe(memory, memory.feed, 50_000);
  observe(memory, feed([lane('a', 'saved', { held: true, changedAt: 2 })]), 60_000);
  assert.equal(memory.shot, first);
  assert.equal(shownMark(memory, 60_000).state, 'waiting');
  const exit = { laneId: 'a', kind: 'landed', at: 7 };
  const landed = run(feed([lane('a', 'ready')]), feed([], exit));
  const shot = landed.shot;
  observe(landed, feed([], { ...exit }), 9_000);
  assert.equal(landed.shot, shot);
});

test('landed holds at least 3 s, then until the next delivery; landing outranks it and failed outranks landing', () => {
  const landed = run(
    feed([lane('a', 'ready'), lane('b', 'editing')]),
    feed([lane('b', 'editing')], { laneId: 'a', kind: 'landed', at: 7 }),
  );
  assert.deepEqual(shownMark(landed, 1000), { state: 'landed', until: 4000 });
  assert.equal(shownMark(landed, 60_000).state, 'landed');
  observe(landed, feed([lane('b', 'editing')], { laneId: 'a', kind: 'landed', at: 7 }), 61_000);
  assert.equal(shownMark(landed, 61_000).state, 'w1');
  const early = run(
    feed([lane('a', 'ready')]),
    feed([], { laneId: 'a', kind: 'landed', at: 7 }),
    feed([lane('c', 'ready')], { laneId: 'a', kind: 'landed', at: 7 }),
  );
  assert.equal(shownMark(early, 2000).state, 'landing');
  const both = run(
    feed([lane('a', 'checking'), lane('b', 'ready')]),
    feed([lane('a', 'saved', { held: true, changedAt: 3 }), lane('b', 'ready')]),
  );
  assert.equal(shownMark(both, 1500).state, 'failed');
});

test('a Lane set aside shows the set-aside pose; a new project starts clean', () => {
  const memory = run(feed([lane('a', 'saved')]), feed([], { laneId: 'a', kind: 'set-aside', at: 9 }));
  assert.equal(shownMark(memory, 1000).state, 'rolledback');
  observe(memory, undefined, 2000);
  assert.deepEqual(shownMark(memory, 2000), { state: 'idle' });
});

test('calming down: looping states calm after 60 s and hold still after 5 min or while reads sleep; one-shots never', () => {
  assert.equal(markMotion('w1', CALM_MS - 1, false), undefined);
  assert.equal(markMotion('w1', CALM_MS, false), 'calm');
  assert.equal(markMotion('idle', STILL_MS, false), 'still');
  assert.equal(markMotion('checks', 0, true), 'still');
  assert.equal(markMotion('landed', STILL_MS, true), undefined);
  assert.equal(markMotion('failed', STILL_MS, false), undefined);
});
