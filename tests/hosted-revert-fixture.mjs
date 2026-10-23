// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { finishFixture, compose } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { saveBytes } from '../dist/hosted-save.js';
export const sync = await import(moduleUrl('../convex/projectHostedSync.ts'));
export const syncJobs = await import(moduleUrl('../convex/projectHostedSyncJobs.ts'));
export { code } from './hosted-finish-fixture.mjs';
export const synthetic = {
  FORGE_HOSTED_CHECK_KEY_ID: 'SYNTHETIC',
  FORGE_SOURCE_WORKER: 'fixed-worker',
  FORGE_SOURCE_RUNTIME: 'a'.repeat(64),
  FORGE_SOURCE_KEY_ID: 'SYNTHETIC',
  R2_ACCOUNT_ID: 'synthetic',
  R2_BUCKET: 'synthetic',
  R2_ACCESS_KEY_ID: 'synthetic',
  R2_SECRET_ACCESS_KEY: 'synthetic',
};
export const maxima = {};
export async function revertFixture(t, options) {
  const f = await finishFixture(t, options),
    c = f.c;
  const call = async (name, fn, args, actor = 'owner') => {
    try {
      return JSON.parse(await f.tx(name, fn, { projectId: f.projectId, ...args }, actor));
    } finally {
      for (const m of f.counts.filter(x => x.name === name)) {
        assert(m.ranges <= 100 && m.documents <= 100, `${name}: constant-size revert reads`);
        assert(m.readBytes < 128 * 1024 && m.writeBytes < 128 * 1024, `${name}: bounded metadata`);
        assert(
          !m.touched.some(x => ['projectHostedAcceptancePages', 'projectHostedAcceptanceEvents'].includes(x)),
          `${name}: no acceptance history or selection hydration`,
        );
        const max = (maxima[name] ??= { ranges: 0, documents: 0, readBytes: 0, writes: 0, writeBytes: 0 });
        for (const key of Object.keys(max)) max[key] = Math.max(max[key], m[key]);
      }
    }
  };
  const request = target => ({
    kind: 'revert',
    operationId: randomUUID(),
    authorityEpoch: 1,
    target,
    message: 'Compensate the actual acceptance',
  });
  const prepare = (r, actor) => call('revertPrepare', sync.prepare, { request: JSON.stringify(r) }, actor);
  const progress = (r, actor) => call('revertProgress', sync.progress, { operationId: r.operationId }, actor);
  const submit = async r => {
    c.put(saveBytes((await progress(r)).input));
    return call('revertSubmit', syncJobs.submit, { operationId: r.operationId });
  };
  const work = async r => {
    const output = await c.compute((await progress(r)).input),
      row = [...f.tables.projectHostedSyncs.values()].find(x => x.operationId === r.operationId),
      job = await c.activate(row.jobId);
    await c.callback(job, { status: 'completed', output: output.output });
    // Execute the synthetic source dispatch directly; never a real provider.
    for (const task of f
      .pending()
      .filter(x => x.name === 'projectModalSource:dispatch' && x.args[0].jobId === job.id))
      f.patch('_scheduled_functions', task._id, { state: { kind: 'success' } });
    return { ...output, jobId: job.id };
  };
  const publish = output =>
    call('revertPublish', syncJobs.publish, { jobId: output.jobId, result: output.manifest });
  const reverse = async r => {
    await prepare(r);
    await submit(r);
    const output = await work(r),
      terminal = await publish(output);
    assert.equal(terminal.outcome.status, 'completed');
    const selected = terminal.outcome.result.lane,
      lane = await f.readLane(selected.laneId),
      entry = {
        laneId: lane.id,
        head: lane.head,
        version: lane.version,
        sourceVersion: lane.sourceVersion,
        lifecycleVersion: lane.lifecycleVersion,
        state: { object: { sha256: lane.head, size: c.objects.get(lane.head).length }, recipe: null },
      };
    return { output, terminal, selected, lane, entry };
  };
  const selection = (inputs, intentId = c.intentId, dependencies = []) => {
    const main = f.currentMain();
    return c.selection(inputs, dependencies, {
      intentId,
      expectedMain: { head: main.head, receiptId: main.receipt.id },
    });
  };
  const finish = async (candidate, chosen) => {
    const state = await f.enqueue(
      f.request({
        candidateId: candidate.id,
        expectedHead: candidate.result.status === 'clean' ? candidate.result.head : null,
        expectedMain: candidate.base,
        finish: { composeOperationId: chosen.request.operationId, after: null },
      }),
    );
    await f.drain();
    return state;
  };
  const settle = async id => {
    await f.passChecks();
    await f.drain();
    return (await f.current(id)).submission;
  };
  const landOriginal = async () => {
    const s = await finish(f.candidate, f.selection),
      final = await settle(s.id);
    assert.equal(final.phase, 'landed');
    return receipt(final.acceptance.receiptId);
  };
  const receipt = id =>
    JSON.parse([...f.tables.projectHostedAcceptances.values()].find(x => x.receiptId === id).value);
  const files = head => JSON.parse(c.objects.get(head)).files;
  const text = (head, path) => {
    const file = files(head).find(x => x.path === path);
    return file ? c.objects.get(file.blob).toString() : null;
  };
  const move = changes => {
    const old = f.currentMain(),
      byPath = new Map(files(old.head).map(x => [x.path, x]));
    for (const file of changes) byPath.set(file.path, file);
    const state = c.state([...byPath.values()], [old.head]);
    c.register(state);
    f.patch('projectHostedChannels', f.mainId, {
      selection: JSON.stringify({
        ...old,
        head: state.sha256,
        receipt: { ...old.receipt, id: randomUUID() },
      }),
    });
    return f.currentMain();
  };
  return {
    ...f,
    revertCall: call,
    revertRequest: request,
    prepareRevert: prepare,
    progressRevert: progress,
    submitRevert: submit,
    workRevert: work,
    publishRevert: publish,
    reverse,
    selectRevert: selection,
    composeRevert: x => compose(c, x),
    finishRevert: finish,
    settleRevert: settle,
    landOriginal,
    receipt,
    files,
    text,
    move,
  };
}
