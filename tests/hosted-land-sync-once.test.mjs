// SPDX-License-Identifier: Apache-2.0
// Item 36fd3295 (incident 5e3c3a3c, section B), land --save half: a land that rejoins its own
// SYNC_REQUIRED entry syncs main in once instead of looping, and every outcome of that one sync is a
// reply land already handles (review 73d4db6d). Behind FORGE_QUEUE_SAME_BYTES_NOT_CONFLICT.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// New in this change: absent on older builds, where the helper tests fail on their first call.
const syncOnce = await import('../dist/hosted-land-sync-once.js').catch(() => ({}));
const SWITCH = 'FORGE_QUEUE_SAME_BYTES_NOT_CONFLICT';
const prior = process.env[SWITCH];
test.after(() => {
  if (prior === undefined) delete process.env[SWITCH];
  else process.env[SWITCH] = prior;
});
const withSwitch = (on, run) => async t => {
  if (on) process.env[SWITCH] = '1';
  else delete process.env[SWITCH];
  try {
    await run(t);
  } finally {
    delete process.env[SWITCH];
  }
};

const ROOT = '/synthetic';
const LANE = randomUUID();
const quiet = () => {};
/** A scripted client: records every call and answers from `replies` in order. */
function client(replies) {
  const calls = [];
  return {
    calls,
    call: async (action, body) => {
      calls.push({ action, body });
      return replies[action].shift();
    },
  };
}
const syncRequired = id => ({
  operationId: 'op-1',
  result: {
    phase: 'finish',
    code: 'SYNC_REQUIRED',
    submission: { id, operationId: 'op-1', phase: 'queued', observation: { state: 'pending' } },
    syncRequired: { paths: ['a.ts'], more: 0, landedSubmissionId: 'landed', laneId: LANE },
    command: `nforge agent ${ROOT} land --save {}`,
    next: { action: 'land', save: true },
  },
});
const synced = status => ({
  operationId: 'sync-op',
  result: { source: { outcome: { status: 'completed', result: { status } } } },
});
const RESOLUTION = randomUUID();
const conflictGuidance = {
  laneId: RESOLUTION,
  paths: ['a.ts'],
  more: 0,
  next: { action: 'resolve', laneId: RESOLUTION },
  command: `nforge agent ${ROOT} resolve {"laneId":"${RESOLUTION}"}`,
  instruction: 'Edit a.ts, then resolve.',
};
const syncConflict = () => ({
  ...synced('conflict'),
  result: { ...synced('conflict').result, conflict: conflictGuidance },
});
/** A sync that outlived its wait: the reply is the source progress, with no completed outcome. */
const syncRunning = () => ({
  operationId: 'sync-op',
  result: { status: 'submitted', jobId: 'job-1', source: { jobId: 'job-1', status: 'running' } },
});

test(
  'helper, switch on: a land that rejoined its SYNC_REQUIRED entry syncs main in once and lands the new head',
  withSwitch(true, async () => {
    const landed = {
      operationId: 'op-2',
      result: { phase: 'finish', submission: { id: 'sub-2', phase: 'queued' } },
    };
    const c = client({ sync: [synced('merged')], finish: [landed] });
    const out = await syncOnce.syncRequiredOnce(
      ROOT,
      { laneId: LANE, message: 'm', operationId: 'op-1' },
      syncRequired('sub-1'),
      c.call,
      quiet,
    );
    assert.equal(out.operationId, 'op-2');
    assert.equal(out.result.submission.id, 'sub-2');
    assert.ok(syncOnce.syncOnceRelanded(out));
    assert.deepEqual(
      c.calls.map(call => call.action),
      ['sync', 'finish'],
    );
    assert.deepEqual(c.calls[0].body, { laneId: LANE });
    assert.equal(c.calls[1].body.message, 'm');
    assert.notEqual(c.calls[1].body.operationId, 'op-1', 'a new landing, not a replay of the stale one');
  }),
);

test(
  'helper, switch on: never loops; a second SYNC_REQUIRED on the same entry, or a completed sync that moves nothing, stops with no land --save',
  withSwitch(true, async () => {
    const again = client({ sync: [synced('merged')], finish: [syncRequired('sub-1')] });
    const stopped = await syncOnce.syncRequiredOnce(
      ROOT,
      { laneId: LANE },
      syncRequired('sub-1'),
      again.call,
      quiet,
    );
    assert.equal(again.calls.length, 2, 'one sync, one landing, nothing more');
    assert.ok(syncOnce.syncOnceStopped(stopped));
    assert.equal(stopped.result.command, undefined);
    assert.equal(stopped.result.next, undefined);
    assert.match(stopped.result.instruction, /Not retrying/);

    const still = client({ sync: [synced('up-to-date')], finish: [] });
    const unmoved = await syncOnce.syncRequiredOnce(
      ROOT,
      { laneId: LANE },
      syncRequired('sub-1'),
      still.call,
      quiet,
    );
    assert.deepEqual(
      still.calls.map(call => call.action),
      ['sync'],
    );
    assert.ok(syncOnce.syncOnceStopped(unmoved));
  }),
);

test(
  'helper, switch on: a failed sync is a failure with a fresh sync to retry, not a capped stop',
  withSwitch(true, async () => {
    const failed = {
      operationId: 'sync-op',
      result: { outcome: { status: 'failed', error: { code: 'SOURCE_FAILED' } } },
    };
    const c = client({ sync: [failed], finish: [] });
    const out = await syncOnce.syncRequiredOnce(ROOT, { laneId: LANE }, syncRequired('sub-1'), c.call, quiet);
    assert.equal(out.result.status, 'failed');
    assert.deepEqual(out.result.error, { code: 'SOURCE_FAILED' });
    assert.deepEqual(out.result.next, { action: 'sync', laneId: LANE });
    assert.equal(syncOnce.syncOnceStopped(out), false);
  }),
);

test(
  'helper, switch off: nothing changes (no sync, no second landing)',
  withSwitch(false, async () => {
    const c = client({ sync: [], finish: [] });
    assert.equal(
      await syncOnce.syncRequiredOnce(ROOT, { laneId: LANE }, syncRequired('sub-1'), c.call, quiet),
      undefined,
    );
    assert.equal(c.calls.length, 0);
    process.env[SWITCH] = '1';
    const on = client({ sync: [], finish: [] });
    const queued = { result: { phase: 'finish', submission: { id: 'sub-3', phase: 'queued' } } };
    assert.equal(await syncOnce.syncRequiredOnce(ROOT, {}, queued, on.call, quiet), undefined);
    assert.equal(on.calls.length, 0);
  }),
);

/** The real compiled land command (wait:true, in process) with a scripted hosted client and observer. */
async function landCommand(t, syncReply) {
  const calls = [],
    observed = [],
    err = [];
  const key = `__syncOnce${randomUUID().replaceAll('-', '')}`;
  globalThis[key] = {
    HostedAgentTransport: class {},
    hostedAgentCli: async (_root, action, body) => {
      calls.push({ action, body });
      if (action === 'sync') return syncReply;
      return { schema: 1, transport: 'hosted', action: 'finish', ...syncRequired('sub-1') };
    },
    observeHostedSubmissions: async (_transport, selection) => {
      observed.push(selection);
      return { result: { status: 'timeout', submissions: [] } };
    },
    observeHostedRun: async () => {
      observed.push('run');
      return { result: { status: 'timeout' } };
    },
  };
  const stubs = {
    './hosted-agent-transport.js': 'HostedAgentTransport',
    './hosted-agent-cli.js': 'hostedAgentCli',
    './hosted-agent-submission-wait.js': 'observeHostedSubmissions',
    './hosted-agent-observe.js': 'observeHostedRun',
  };
  const source = readFileSync(new URL('../dist/hosted-land-cli.js', import.meta.url), 'utf8').replace(
    /from '([^']+)'/g,
    (match, path) => {
      if (stubs[path])
        return `from '${'data:text/javascript,' + encodeURIComponent(`export const ${stubs[path]} = globalThis.${key}.${stubs[path]};`)}'`;
      return path.startsWith('.')
        ? `from '${new URL(`../dist/${path.slice(2)}`, import.meta.url).href}'`
        : match;
    },
  );
  const cli = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const oldOut = process.stdout.write,
    oldErr = process.stderr.write,
    oldExit = process.exitCode;
  process.stdout.write = () => true;
  process.stderr.write = chunk => {
    err.push(String(chunk));
    return true;
  };
  let exitCode;
  try {
    process.exitCode = undefined;
    const response = await cli.hostedLandCli(
      ROOT,
      { laneId: LANE, message: 'Land' },
      { url: 'https://fixture.invalid', projectId: 'synthetic' },
      { detach: false, wait: true },
    );
    exitCode = process.exitCode;
    return { response, calls, observed, err, exitCode };
  } finally {
    process.stdout.write = oldOut;
    process.stderr.write = oldErr;
    process.exitCode = oldExit;
    delete globalThis[key];
    void t;
  }
}

test(
  'review 73d4db6d MUST 1: a conflict on the one sync returns its resolve guidance and never enters the landing observer',
  withSwitch(true, async t => {
    const land = await landCommand(t, syncConflict());
    assert.deepEqual(
      land.calls.map(call => call.action),
      ['finish', 'sync'],
      'one sync, no second landing',
    );
    assert.deepEqual(land.observed, [], 'the sync operation is never observed as a landing');
    assert.equal(land.response.result.phase, 'conflict');
    assert.deepEqual(land.response.result.recovery.conflict, conflictGuidance);
    assert.equal(land.exitCode, 2);
    assert.ok(
      land.err.some(line => line.includes('Edit a.ts, then resolve.')),
      'the guidance is printed',
    );
    // Everything after the one sync starts is its outcome; none of it offers land --save to loop on.
    const after = land.err.slice(
      land.err.findIndex(line => line.includes('syncing main into this Lane once')),
    );
    assert.ok(after.length > 1 && !after.some(line => line.includes('land --save')), after.join(''));
  }),
);

test(
  'review 73d4db6d MUST 2: an unfinished sync returns a recoverable reply that keeps its operation id, never a terminal one',
  withSwitch(true, async t => {
    const land = await landCommand(t, syncRunning());
    assert.deepEqual(land.observed, [], 'no landing observer for source work');
    const result = land.response.result;
    assert.notEqual(result.terminal, true);
    assert.equal(result.inProgress, true);
    assert.equal(result.phase, 'sync');
    assert.deepEqual(result.next, { action: 'sync', laneId: LANE, operationId: 'sync-op' });
    assert.match(result.command, /sync .*"operationId":"sync-op"/);
    assert.equal(syncOnce.syncOnceStopped(land.response), false);
    assert.equal(land.exitCode, 3, 'in progress, like any source work that outlived the budget');
    assert.ok(
      land.err.some(line => line.includes('sync-op')),
      'the resume command names the running sync',
    );
  }),
);
