// SPDX-License-Identifier: Apache-2.0
// Item 9b9057a9 (owner, dev site, 2026-11-23): one held Lane was "Needs you · held, why not reported" on the flow and the
// Lanes page, "Nothing is held" in the Now headline, 0 in the top bar and nothing on the Held page. Every surface that
// says a Lane is held or waits on the reader now takes one rule: needs/count.ts (`needsCount`, `needsYouLanes`) decides
// who waits, `lane-state.ts` words the hold, and the Held page lists the same rows. These cases run the same project
// state through each surface: a Lane held on its agent, a Lane held for the reader's approval, a question for the
// reader, and none.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';

const model = await import(moduleUrl('../web/src/app/needs/model.ts'));
const count = await import(moduleUrl('../web/src/app/needs/count.ts'));
const fyi = await import(moduleUrl('../web/src/app/needs/fyi.ts'));
const laneStateModule = await import(moduleUrl('../web/src/app/lane-state.ts'));
const { lineStopCounts, lineStops } = await import(moduleUrl('../web/src/app/Line.tsx'));
const { baseMark } = await import(moduleUrl('../web/src/app/mark.ts'));

const NOW = Date.UTC(2026, 10, 23, 9, 0);
const held = (laneId, why, extra = {}) => ({
  laneId,
  intentId: `i-${laneId}`,
  title: `Title ${laneId}`,
  actor: 'sample-one',
  agent: 'quiet-otter',
  why,
  note: null,
  submissionId: `s-${laneId}`,
  since: NOW - 3_600_000,
  ...extra,
});
const read = (lanes, extra = {}) => ({
  held: lanes,
  more: 0,
  moreIsLowerBound: false,
  approvals: JSON.stringify({ requests: [], complete: true }),
  canDecide: true,
  ...extra,
});
const ask = laneId => ({
  id: `ask-${laneId}`,
  at: NOW - 60_000,
  actor: 'sample-one',
  agent: 'quiet-otter',
  text: 'Which one lands first?',
  choices: ['a', 'b'],
  laneId,
});
/** The line feed's mark for a held Lane, as the server writes it: `fix` when the hold is its agent's next step. */
const mark = (laneId, extra = {}) => ({
  laneId,
  stage: 'saved',
  held: true,
  overlap: false,
  changedAt: 1,
  ...extra,
});
const emptyFyi = {
  owner: true,
  state: { clearedAt: null, clearedSequence: null, dismissed: [] },
  landings: [],
  landingsMore: false,
  broke: [],
  settings: [],
  access: [],
  messages: [],
  messagesMore: false,
};

/** Everything the screens say about one project state. */
function surfaces(needsRead, lanes) {
  const view = model.needsView(needsRead, NOW);
  const needsYou = count.needsYouLanes(needsRead, NOW);
  const waiting = count.waitingLanes(needsYou);
  const feed = { lanes, more: 0, moreIsLowerBound: false, main: null };
  const saved = lineStops.find(stop => stop.stage === 'saved');
  const heldPage = fyi.fyiView(emptyFyi, [...view.now, ...view.fyi], NOW);
  return {
    badge: count.needsCount(needsRead, NOW).n,
    nowRows: view.now.length + view.asks.length + view.parked.length,
    nowHeadline: model.needsSentence(view),
    heldHeadline: model.heldSentence(view),
    heldPageRows: heldPage.rows.filter(row => !row.event).map(row => row.key.split('@')[0]),
    // The top bar's line says "held" only for Lanes that wait on the reader.
    lineHeld: lineStopCounts(feed, saved, waiting).held,
    mark: baseMark(feed, waiting),
    // The yard row and the flow say the same word for each held Lane: Needs you only where the count counts it.
    words: Object.fromEntries(
      lanes.map(lane => {
        const row = [...view.now, ...view.fyi].find(entry => entry.laneId === lane.laneId);
        return [lane.laneId, row?.word];
      }),
    ),
  };
}

test('9b9057a9: a Lane held on its agent is held on every surface and needs nobody on any of them', () => {
  // The incident: the live line marks it held, Needs me knows no reason for it (its landing is gone).
  const read1 = read([held('88671ba0', 'unknown')]);
  const said = surfaces(read1, [mark('88671ba0', { fix: true })]);
  assert.equal(said.badge, 0, 'the top bar and the sidebar badge');
  assert.equal(said.nowRows, 0, 'Now lists nothing for the reader');
  assert.equal(said.nowHeadline.bold, 'Nothing needs you.');
  assert.doesNotMatch(
    said.nowHeadline.rest,
    /Nothing is held/,
    'never "nothing is held" while a Lane is held',
  );
  assert.match(said.nowHeadline.rest, /1 Lane is held/);
  assert.equal(said.heldHeadline.bold, '1 Lane is held now.');
  assert.deepEqual(said.heldPageRows, ['held:88671ba0'], 'the Held page lists it');
  assert.equal(said.lineHeld, 0, 'the line counts only holds that wait on the reader');
  assert.notEqual(said.mark, 'waiting');
  assert.notEqual(said.words['88671ba0'], 'Needs you');
  assert.doesNotMatch(JSON.stringify(model.needsView(read1, NOW).fyi), /why not reported|Why: not reported/);
});

test('9b9057a9: the same hold with a person-hold flag but no review on record is not counted by the line either', () => {
  // The mark lagged (held, no `fix`) while Needs me's read found no review: the read decides, everywhere.
  const said = surfaces(read([held('lag', 'unknown')]), [mark('lag')]);
  assert.equal(said.badge, 0);
  assert.equal(said.lineHeld, 0, 'the line follows Needs me, not the lagging flag');
  assert.notEqual(said.mark, 'waiting');
  // Until Needs me's read answers, the line's own flag stands in.
  assert.equal(lineStopCounts({ lanes: [mark('lag')], more: 0 }, lineStops[1]).held, 1);
});

test("9b9057a9: a Lane held for the reader's approval is counted and listed by every surface", () => {
  const said = surfaces(read([held('rev', 'review')]), [mark('rev')]);
  assert.equal(said.badge, 1);
  assert.equal(said.nowRows, 1);
  assert.match(said.nowHeadline.bold, /^1 thing holds work until you decide\.$/);
  assert.equal(said.heldHeadline.bold, '1 Lane is held now.');
  assert.match(said.heldHeadline.rest, /1 waits on you/);
  assert.deepEqual(said.heldPageRows, ['held:rev']);
  assert.equal(said.lineHeld, 1);
  assert.equal(said.mark, 'waiting');
  assert.equal(said.words.rev, 'Needs you');
});

test('9b9057a9: a question waiting for the reader is counted, and no Lane is held', () => {
  const said = surfaces(read([], { asks: [ask('lane-q')] }), []);
  assert.equal(said.badge, 1);
  assert.equal(said.nowRows, 1);
  assert.equal(said.heldHeadline.bold, 'Nothing is held now.');
  assert.deepEqual(said.heldPageRows, []);
  assert.equal(said.lineHeld, 0);
});

test('9b9057a9: with nothing held and nothing asked every surface says none', () => {
  const said = surfaces(read([]), []);
  assert.equal(said.badge, 0);
  assert.equal(said.nowRows, 0);
  assert.equal(said.nowHeadline.rest, 'Nothing is held and no agent is waiting for an answer.');
  assert.equal(said.heldHeadline.bold, 'Nothing is held now.');
  assert.deepEqual(said.heldPageRows, []);
  assert.equal(said.lineHeld, 0);
});

test('9b9057a9: past the read limit the line falls back to its own flag, never to a guess from a partial read', () => {
  const partial = read([held('a', 'review')], { more: 5, moreIsLowerBound: true });
  assert.equal(count.waitingLanes(count.needsYouLanes(partial, NOW)), undefined);
  assert.equal(count.needsCount(partial, NOW).atLeast, true);
});

test('9b9057a9: a hold with no landing outcome on record names its next step, on the board and on the Lane page', () => {
  const view = model.needsView(read([held('gone', 'unknown')]), NOW);
  assert.match(view.fyi[0].head, /no landing outcome on record/);
  assert.match(view.fyi[0].next, /lands it again from the Lane/);
  assert.match(
    model.holdLine(view, 'gone', NOW),
    /^Held \(1 h\): no landing outcome on record\. Next: .+ lands it again/,
  );
  assert.equal(laneStateModule.heldState({ state: 'unknown' }).glyph, 'Stopped');
});

test('9b9057a9 review: the Held page keeps every Lane held now after Clear all or a dismissal', () => {
  const input = read([held('rev', 'review')]);
  const view = model.needsView(input, NOW);
  const cleared = { ...emptyFyi, state: { clearedAt: NOW, clearedSequence: 1, dismissed: [] } };
  assert.equal(
    fyi.fyiView(cleared, [...view.now, ...view.fyi], NOW).rows.length,
    0,
    'Needs me FYI honours Clear all',
  );
  assert.equal(
    fyi.fyiView(cleared, [...view.now, ...view.fyi], NOW, true).rows.length,
    1,
    'the Held page does not',
  );
});

test('9b9057a9 review: a review-held Lane that has passed its check shows the F as waiting, not landing', () => {
  const lane = mark('ready-held', { stage: 'ready' });
  assert.equal(baseMark({ lanes: [lane], more: 0 }, new Set(['ready-held'])), 'waiting');
  assert.equal(baseMark({ lanes: [{ ...lane, held: false }], more: 0 }), 'landing');
});

test('9b9057a9 review: a capped read says "at least" on the Held headline', () => {
  const view = model.needsView(read([held('a', 'check-failed')], { more: 3, moreIsLowerBound: true }), NOW);
  assert.match(model.heldSentence(view).bold, /^At least 1 Lane is held now\.$/);
});
