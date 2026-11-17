// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { batchesFixture, states } from '../hosted-landing-batches-fixture.mjs';
const rows = f => [...f.tables.projectHostedLandingRequests.values()];
const owner = (f, run) =>
  [...f.tables.projectHostedLandingAttempts.values()].find(
    row => JSON.parse(row.value).check?.runId === run.id,
  )?.submissionId;
const work = f => f.pending().find(task => !/MainAudit:start|LandingStall/.test(task.name));
// `seed(f, ids)` may reshape rows once every follower is parked, before the head passes.
export async function parkedIncident(t, { seed } = {}) {
  const f = await batchesFixture(t, {
    count: 6,
    fileCount: 2,
    batching: false,
    requestCheck: true,
    memberPaths: [
      'src/shared.ts',
      'src/shared.ts',
      ...Array.from({ length: 4 }, (_, i) => `src/independent-${i}.ts`),
    ],
    baselineFiles: [['src/shared.ts', 'export const a = 0;\n// gap\nexport const b = 0;\n']],
    memberContents: [
      'export const a = 1;\n// gap\nexport const b = 0;\n',
      'export const a = 0;\n// gap\nexport const b = 1;\n',
    ],
  });
  f.rawChecks.setPlanSelection(JSON.stringify({ scope: 'full', tests: [] }));
  const [head, holder, ...followers] = f.entries.map(e => e.state.id);
  let headRun;
  for (let tick = 0; tick < 250; tick++) {
    const a = rows(f).find(r => r.submissionId === holder);
    if (a) f.patch('projectHostedLandingRequests', a._id, { unsealed: 'not-eligible' });
    for (const run of f.runs().filter(r => r.status === 'queued' && r.gate?.mode !== 'audit')) {
      const active = await f.rawChecks.activate(run.id);
      if (owner(f, run) === head) headRun = active;
      else await f.rawChecks.pass(active);
    }
    if (followers.every(id => rows(f).find(r => r.submissionId === id)?.orderWait === holder)) break;
    const task = work(f);
    if (!task) break;
    await f.execute(task);
  }
  assert(headRun);
  assert.equal(rows(f).find(r => r.submissionId === holder).orderWait, head);
  for (const id of followers) {
    const row = rows(f).find(r => r.submissionId === id);
    assert.equal(row.orderWait, holder);
    // The old code has no alarm here; the invariant inspector reports L1.
  }
  await seed?.(f, { head, holder, followers });
  await f.rawChecks.pass(headRun);
  let holderRechecked = false,
    waiterReclaimed = false;
  for (let tick = 0; tick < 350; tick++) {
    for (const run of f.runs().filter(r => r.status === 'queued' && r.gate?.mode !== 'audit')) {
      if (owner(f, run) === holder) {
        holderRechecked = true;
        continue;
      }
      await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    }
    // The holder's re-check run is bound; stop once it is checking that run (the new-run wake).
    if (holderRechecked && rows(f).find(r => r.submissionId === holder).phase === 'checking') {
      const oldest = rows(f).find(r => r.submissionId === followers[0]);
      waiterReclaimed = oldest.orderWait !== holder && Boolean(oldest.alarm);
      break;
    }
    if (followers.every(id => states(f).find(s => s.id === id).phase === 'landed')) break;
    const task = work(f);
    if (!task) break;
    await f.execute(task);
  }
  assert(holderRechecked);
  return { f, followers, holder, head, waiterReclaimed };
}
