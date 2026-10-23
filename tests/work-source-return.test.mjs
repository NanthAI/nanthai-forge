import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSourceReturn } from '../dist/work-source-return.js';
const head = 'a'.repeat(64),
  other = 'b'.repeat(64);
const manifest = {
  kind: 'forge-native-work-backup',
  head,
  files: [{ path: `objects/${head}`, sha256: head }],
};
const empty = () => ({
  revision: 0,
  hostedEvents: [],
  hostedChannelMoves: [],
  intents: [],
  lanes: [],
  views: [],
  planningItems: [],
  planningComments: [],
  historicalWork: [],
  channelMoves: [],
});
const intent = id => ({
  id,
  base: head,
  outcome: 'Retain source',
  constraints: '',
  createdAt: 'now',
  notes: [{ text: 'Original', kind: 'comment', at: 'now' }],
});
const move = id => ({ id, status: 'accepted', head, previous: null, viewId: 'view', channel: 'main' });
const fails = (current, next, message, source = manifest) =>
  assert.throws(
    () => validateSourceReturn(current, next, source),
    error => error.code === 'INVALID_WORK_JOURNAL' && error.message.includes(message),
  );

test('retains complete unknown collections and compares historical/planning JSON in original property order', () => {
  const current = { ...empty(), future: [{ id: 'extension', payload: { untouched: true } }, { noId: true }] };
  const next = structuredClone(current);
  next.future[0].payload = { existingPredicateAllowsChanges: true };
  validateSourceReturn(current, next, manifest);
  next.future.shift();
  fails(current, next, 'omits retained Work');
  next.future = current.future;
  delete next.future;
  fails(current, next, 'omits retained Work');
  for (const collection of ['planningItems', 'planningComments', 'historicalWork']) {
    const original = { ...empty(), [collection]: [{ id: 'one', value: 2 }] };
    fails(
      original,
      { ...original, [collection]: [{ value: 2, id: 'one' }] },
      collection === 'historicalWork' ? 'historical archive' : 'planning history',
    );
  }
});

test('Intent, historical and receipt lookups select the first duplicate candidate ID', () => {
  for (const collection of ['intents', 'historicalWork', 'channelMoves']) {
    const original =
      collection === 'intents'
        ? intent('one')
        : collection === 'channelMoves'
          ? move('one')
          : { id: 'one', value: 2 };
    const changed =
      collection === 'intents'
        ? { ...original, outcome: 'Changed' }
        : collection === 'channelMoves'
          ? { ...original, head: other }
          : { ...original, value: 3 };
    const current = { ...empty(), [collection]: [original] };
    const next = { ...current, [collection]: [original, changed] };
    validateSourceReturn(current, next, manifest);
    next[collection].reverse();
    fails(
      current,
      next,
      collection === 'intents'
        ? 'Intent source'
        : collection === 'channelMoves'
          ? 'Channel receipt'
          : 'historical archive',
    );
  }
});

test('planning lookup preserves first ID/version match and optional strict version semantics', () => {
  for (const collection of ['planningItems', 'planningComments']) {
    for (const version of [undefined, 1, '1', null]) {
      const original = { id: 'one', version, value: 'original' };
      const current = { ...empty(), [collection]: [original] };
      const next = {
        ...current,
        [collection]: [
          { id: 'one', value: 'missing version' },
          { ...original },
          { ...original, value: 'later' },
        ],
      };
      validateSourceReturn(current, next, manifest);
      next[collection].splice(1, 0, { ...original, value: 'first wrong value' });
      fails(current, next, 'planning history');
    }
    const original = { id: 'one', value: 'without version' },
      current = { ...empty(), [collection]: [original] };
    fails(current, { ...current, [collection]: [{ ...original, version: 1 }, original] }, 'planning history');
    const nan = { ...original, version: NaN };
    fails({ ...current, [collection]: [nan] }, { ...current, [collection]: [nan] }, 'planning history');
    const objectVersion = {},
      value = { ...original, version: objectVersion };
    validateSourceReturn(
      { ...current, [collection]: [value] },
      { ...current, [collection]: [value] },
      manifest,
    );
    fails(
      { ...current, [collection]: [value] },
      { ...current, [collection]: [{ ...value, version: {} }] },
      'planning history',
    );
  }
});

test('validator retains rejection order and evaluates source dependencies only for matching accepted receipts', () => {
  const current = {
    ...empty(),
    intents: [intent('one')],
    planningComments: [{ id: 'comment', text: 'original' }],
    channelMoves: [move('move')],
  };
  const next = structuredClone(current);
  next.intents[0].outcome = 'changed';
  next.planningComments[0].text = 'changed';
  let reads = 0;
  const broken = {
    ...manifest,
    get files() {
      reads++;
      throw new Error('source validation failed');
    },
  };
  fails(current, next, 'Intent source', broken);
  assert.equal(reads, 0);
  next.intents = current.intents;
  fails(current, next, 'planning history', broken);
  assert.equal(reads, 0);
  next.planningComments = current.planningComments;
  next.channelMoves[0].head = other;
  fails(current, next, 'Channel receipt', broken);
  assert.equal(reads, 0);
  next.channelMoves = current.channelMoves;
  assert.throws(() => validateSourceReturn(current, next, broken), /source validation failed/);
  assert.equal(reads, 1);
  const noMoves = { ...current, channelMoves: [] };
  validateSourceReturn(noMoves, noMoves, broken);
  assert.equal(reads, 1);
  next.hostedChannelMoves = [{ changed: true }];
  next.hostedEvents = [{ changed: true }];
  fails(current, next, 'hosted Channel receipts');
  next.hostedChannelMoves = [];
  current.hostedEvents = [{ original: true }];
  fails(current, next, 'hosted operation history');
});

test('source membership remains native state based or exact Git receipt reference based', () => {
  const current = { ...empty(), channelMoves: [move('one'), move('two')] };
  let scans = 0;
  const native = {
    ...manifest,
    get files() {
      scans++;
      return manifest.files;
    },
  };
  validateSourceReturn(current, current, native);
  assert.equal(scans, 1, 'derive archive source once within this validation');
  validateSourceReturn(current, current, native);
  assert.equal(scans, 2, 'no cross-validation authority cache');
  const git = {
    kind: 'forge-source-and-work',
    head,
    refs: [
      { ref: 'refs/forge/channel-moves/one', head },
      { ref: 'refs/forge/channel-moves/two', head },
    ],
  };
  validateSourceReturn(current, current, git);
  fails(current, current, 'Channel receipt', { ...git, refs: [{ ref: 'other', head }] });
  fails(current, current, 'Channel receipt', { ...manifest, files: [] });
});

test('retained record validation scales linearly in candidate ID reads at 100, 1000 and 10000 records', t => {
  for (const size of [100, 1000, 10000]) {
    const current = {
      ...empty(),
      intents: Array.from({ length: size }, (_, i) => intent(`intent-${i}`)),
      planningItems: Array.from({ length: size }, (_, i) => ({ id: `plan-${i}`, version: 1, value: i })),
    };
    const next = structuredClone(current);
    let reads = 0;
    for (const collection of ['intents', 'planningItems'])
      for (const row of next[collection]) {
        const id = row.id;
        Object.defineProperty(row, 'id', {
          enumerable: true,
          get() {
            reads++;
            return id;
          },
        });
      }
    const start = performance.now();
    validateSourceReturn(current, next, manifest);
    const durationMs = performance.now() - start;
    assert(reads <= size * 12, `candidate reads ${reads} exceeded linear bound for ${size}`);
    t.diagnostic(JSON.stringify({ size, candidateIdReads: reads, durationMs }));
  }
});

test('Intent note prefix and original source fields remain protected while permitted append/extension changes remain allowed', () => {
  const current = {
    ...empty(),
    intents: [
      {
        ...intent('one'),
        baseChannel: { name: 'main', head, acceptanceId: 'accepted' },
        hostedBase: { name: 'release', head, acceptanceId: 'hosted' },
        extension: 'original',
      },
    ],
  };
  const next = structuredClone(current);
  next.intents[0].notes.push({ text: 'Added', kind: 'comment', at: 'later' });
  next.intents[0].extension = 'allowed';
  validateSourceReturn(current, next, manifest);
  for (const field of ['base', 'outcome', 'constraints', 'createdAt']) {
    const changed = structuredClone(next);
    changed.intents[0][field] = 'changed';
    fails(current, changed, 'Intent source');
  }
  for (const key of ['baseChannel', 'hostedBase'])
    for (const field of ['name', 'head', 'acceptanceId']) {
      const changed = structuredClone(next);
      changed.intents[0][key][field] = 'changed';
      fails(current, changed, 'Intent source');
    }
  for (const field of ['text', 'kind', 'at']) {
    const changed = structuredClone(next);
    changed.intents[0].notes[0][field] = 'changed';
    fails(current, changed, 'Intent source');
  }
  const omitted = structuredClone(next);
  omitted.intents[0].notes.shift();
  fails(current, omitted, 'Intent source');
  const stale = { ...next, revision: -1 };
  fails(current, stale, 'hosted operation history');
});
