// SPDX-License-Identifier: Apache-2.0
// Core-claim incident 10d253c6 (2026-11-10, one-client slice 1): a 130-path deletion Lane took 10
// land operations and about 2.5 h stranded. Its pre-queue check held no queue order, small Lanes
// kept landing into the three hot files it rewrote, and each passed check then failed
// COMPOSITION_CONFLICT at acceptance: every main edit anywhere in a file the Lane cut 500+ lines
// from conflicted (the line diff gave up past 512 edits), and main's edits inside the sections it
// deleted conflicted for real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { compose, records } from './hosted-finish-fixture.mjs';
import { markNativeTextConflicts, mergeNativeText } from '../dist/native-text-merge.js';
import { HOSTED_RESERVATION_MS } from '../dist/landing-reservation.js';

const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const MIN = 60_000;
const HOT = ['docs/agents/workflow.md', 'docs/operations.md', 'src/agent-cli.ts'];
const LINES = 1200,
  CUT = [100, 700]; // the Lane deletes these 600 lines of each hot file and writes 20 of its own
const NATIVE = Array.from({ length: 127 }, (_, i) => `src/native/part-${String(i).padStart(3, '0')}.ts`);
const baseLines = path => Array.from({ length: LINES }, (_, i) => `${path} line ${i}\n`);
const own = path => Array.from({ length: 20 }, (_, i) => `${path} hosted-only text ${i}\n`);
/** The big Lane's version of a hot file, given main's current lines: its cut and its own text. */
const cut = (path, lines) => [...lines.slice(0, CUT[0]), ...own(path), ...lines.slice(CUT[1])].join('');
/** Stream landing k: one line of one hot file; every third inside the region the big Lane deletes. */
const streamEdit = k => ({
  path: HOT[k % 3],
  line: k % 3 === 1 ? CUT[0] + 40 + k * 3 : CUT[1] + 40 + k * 3,
});

test('the incident shape: a 600-line cut and a main edit elsewhere in the file merge; an edit inside the cut is one local diff3 hunk that offers the deletion', () => {
  const path = HOT[0],
    base = baseLines(path),
    lane = Buffer.from(cut(path, base)),
    elsewhere = base.map((line, i) => (i === 900 ? 'main edit\n' : line)),
    inside = base.map((line, i) => (i === 300 ? 'main edit inside\n' : line));
  const merged = mergeNativeText(Buffer.from(base.join('')), lane, Buffer.from(elsewhere.join('')), path);
  assert.equal(merged?.toString(), cut(path, elsewhere), 'disjoint edits merge byte-exactly');
  assert.equal(mergeNativeText(Buffer.from(base.join('')), lane, Buffer.from(inside.join('')), path), null);
  // A landing resolution: main above, the Lane below (labels ['main', 'lane']).
  const draft = markNativeTextConflicts(Buffer.from(base.join('')), Buffer.from(inside.join('')), lane, [
    'main',
    'lane',
  ]);
  assert.equal(draft.conflicted, true);
  const text = draft.bytes.toString().split('\n');
  const marks = text.flatMap((line, i) =>
    /^(<<<<<<<|\|\|\|\|\|\|\||=======|>>>>>>>)/.test(line) ? [[i, line]] : [],
  );
  assert.deepEqual(
    marks.map(([, line]) => line.split(' ')[0]),
    ['<<<<<<<', '|||||||', '=======', '>>>>>>>'],
  );
  assert.equal(marks[0][0], CUT[0], 'the hunk starts where the cut starts, not at line 1');
  assert.match(
    marks[3][1],
    /^>>>>>>> lane removed this region; main changed only base line 301 inside it\. Suggested resolution: keep the lane side/,
  );
  // Keeping the Lane side of the one hunk is the deletion with main's edits elsewhere kept.
  const kept = [
    ...text.slice(0, marks[0][0]),
    ...text.slice(marks[2][0] + 1, marks[3][0]),
    ...text.slice(marks[3][0] + 1),
  ];
  assert.equal(kept.join('\n'), cut(path, base));
  // An ordinary same-line conflict carries no suggestion; a removal by main never suggests dropping the Lane's edit.
  const same = markNativeTextConflicts(
    Buffer.from('a\nb\nc\n'),
    Buffer.from('a\nMAIN\nc\n'),
    Buffer.from('a\nLANE\nc\n'),
    ['main', 'lane'],
  );
  assert.equal(
    same.bytes.toString(),
    'a\n<<<<<<< main\nMAIN\n||||||| base\nb\n=======\nLANE\n>>>>>>> lane\nc\n',
  );
  const removedByMain = markNativeTextConflicts(
    Buffer.from(base.join('')),
    lane,
    Buffer.from(inside.join('')),
    ['main', 'lane'],
  );
  assert.doesNotMatch(removedByMain.bytes.toString(), /Suggested resolution/);
});

/** Replay: the big Lane against a stream of small hot-file landings on the real hosted queue
 * (pre-queue Lane checks, batching, fake clock). Its check takes 12 min, each stream check 3 min,
 * one stream Lane every 4 min, the agent resolves a conflict in 5 min (all as on dogfood). */
async function replay(t, { maxAttempts = 6 } = {}) {
  const f = await batchesFixture(t, {
    count: 0,
    batching: true,
    admissionCheck: 'full',
    baselineFiles: [
      ...HOT.map(path => [path, baseLines(path).join('')]),
      ...NATIVE.map(path => [path, `export const part = '${path}';\n`]),
    ],
  });
  const files = head => new Map(JSON.parse(f.c.objects.get(head)).files.map(file => [file.path, file]));
  const text = (head, path) => f.c.objects.get(files(head).get(path).blob).toString();
  const template = JSON.parse(
    (
      await f.c.run('readTemplate', records.readHostedRecord, {
        ...f.c.auth,
        kind: 'intent',
        key: f.c.intentId,
      })
    ).value,
  );
  /** One Lane on its own Intent, branched from current main, submitted with the dogfood check. */
  const submit = async (intentId, edit) => {
    const main = f.currentMain(),
      base = files(main.head),
      next = new Map(base);
    for (const [path, content] of edit(main.head))
      if (content === null) next.delete(path);
      else next.set(path, f.c.file(path, content));
    const pin = f.c.state([...next.values()], [main.head]);
    const lane = await f.c.lane(pin, { intentId, base: { head: main.head, receiptId: main.receipt.id } });
    for (const table of ['projectHostedRecords', 'projectHostedRecordHeads'])
      for (const row of f.tables[table].values())
        if (row.kind === 'lane' && row.key === lane.laneId) f.patch(table, row._id, { ownerOnly: true });
    const selection = f.c.selection([lane], [], {
      intentId,
      expectedMain: { head: main.head, receiptId: main.receipt.id },
    });
    const candidate = await compose(f.c, selection);
    const state = await f.enqueue(
      f.request({
        governanceVersion: 1,
        candidateId: candidate.id,
        expectedHead: candidate.result.head,
        expectedMain: { head: main.head, receiptId: main.receipt.id },
        finish: { composeOperationId: selection.request.operationId, after: null },
      }),
    );
    return state.id;
  };
  const intent = async label => {
    const id = randomUUID();
    await f.c.run('seedIntent', records.writeHostedRecord, {
      ...f.c.auth,
      expectedVersion: null,
      record: { ...template, id, version: 0, outcome: label },
    });
    return id;
  };
  const big = await intent('Delete the native client (130 paths)');
  const bigEdit = head => [
    ...HOT.map(path => [path, cut(path, text(head, path).match(/[^\n]*\n/g))]),
    ...NATIVE.map(path => [path, null]),
  ];
  const started = Date.now();
  const attempts = [await submit(big, bigEdit)];
  const runStart = new Map(),
    owners = new Map();
  let nextStream = started + 4 * MIN,
    k = 0,
    resolveAt = null;
  const ownerOf = run => {
    if (!owners.has(run.id)) {
      const row = [...f.tables.projectHostedLandingRequests.values()].find(
        r => r.runId === run.id || r.admission?.runId === run.id,
      );
      const batch = [...f.tables.projectHostedLandingBatches.values()].find(
        r => JSON.parse(r.value).runId === run.id,
      );
      owners.set(
        run.id,
        row?.submissionId ?? JSON.parse(batch?.value ?? '{}').members?.map(m => m.submissionId) ?? [],
      );
    }
    return [owners.get(run.id)].flat();
  };
  const bigState = () => states(f).find(s => s.id === attempts.at(-1));
  for (let tick = 0; ; tick++) {
    assert(tick < 4000, 'replay bound');
    const now = Date.now();
    if (bigState()?.phase === 'landed') break;
    if (attempts.length > maxAttempts || now - started > 4 * 60 * MIN) break;
    // Check runs finish after their duration: 12 min if the big Lane is in it, else 3 min.
    for (const run of f.runs().filter(r => r.status === 'queued')) {
      if (!runStart.has(run.id)) runStart.set(run.id, now);
      const long = ownerOf(run).some(id => attempts.includes(id));
      if (now - runStart.get(run.id) >= (long ? 12 : 3) * MIN)
        await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    }
    const due = f.pending().find(task => task.scheduledTime <= now);
    if (due) {
      await f.execute(due);
      continue;
    }
    // The agent resolves a conflict: the cut applied to current main, then lands again.
    const last = bigState();
    if (last?.phase === 'terminal-failed' && resolveAt === null) resolveAt = now + 5 * MIN;
    if (resolveAt !== null && now >= resolveAt) {
      resolveAt = null;
      attempts.push(await submit(big, bigEdit));
      continue;
    }
    if (now >= nextStream) {
      const edit = streamEdit(k++);
      await submit(await intent(`stream ${k}`), head => [
        [
          edit.path,
          text(head, edit.path).replace(
            `${edit.path} line ${edit.line}\n`,
            `${edit.path} line ${edit.line} (stream ${k})\n`,
          ),
        ],
      ]);
      nextStream += 4 * MIN;
      continue;
    }
    const wake = Math.min(
      nextStream,
      resolveAt ?? Infinity,
      ...f
        .runs()
        .filter(r => r.status === 'queued' && runStart.has(r.id))
        .map(r => runStart.get(r.id) + (ownerOf(r).some(id => attempts.includes(id)) ? 12 : 3) * MIN),
      f.pending()[0]?.scheduledTime ?? Infinity,
    );
    f.advanceClock(Math.max(1, wake - now));
  }
  const landed = bigState()?.phase === 'landed';
  const codes = attempts.map(
    id => states(f).find(s => s.id === id)?.error?.code ?? states(f).find(s => s.id === id)?.phase,
  );
  const rows = [...f.tables.projectHostedLandingRequests.values()];
  return {
    f,
    landed,
    attempts: attempts.length,
    codes,
    strandedMinutes: Math.round((Date.now() - started) / MIN),
    streamLanded: states(f).filter(s => s.phase === 'landed' && !attempts.includes(s.id)).length,
    reservation: rows.find(r => r.submissionId === attempts[1]),
    reservedWaits: rows.filter(
      r => !attempts.includes(r.submissionId) && r.orderWaits?.some(w => w.held === 'reserved'),
    ).length,
  };
}

test('incident replay 10d253c6: a 130-path Lane against a stream of small hot-file landings lands within 2 attempts', async t => {
  const result = await replay(t);
  t.diagnostic(
    JSON.stringify({
      attempts: result.attempts,
      codes: result.codes,
      minutes: result.strandedMinutes,
      stream: result.streamLanded,
      reservedWaits: result.reservedWaits,
    }),
  );
  assert.equal(result.landed, true, JSON.stringify(result.codes));
  assert(result.attempts <= 2, `landed after ${result.attempts} attempts: ${JSON.stringify(result.codes)}`);
  assert(result.streamLanded > 0, 'the stream kept landing meanwhile');
  if (result.attempts === 2) {
    // The second attempt was reserved, bounded, and the reservation ended with its landing.
    assert.equal(result.reservation.superseded, 1);
    assert.equal(result.reservation.reservedUntil, undefined, 'cleared when it landed');
    assert.equal(result.codes[0], 'COMPOSITION_CONFLICT');
    assert(result.reservedWaits > 0, 'a stream landing waited for the reservation');
  }
  assert(result.strandedMinutes < 60, `${result.strandedMinutes} min to main`);
  assert(HOSTED_RESERVATION_MS <= 30 * MIN);
});
