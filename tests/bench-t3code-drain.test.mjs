// SPDX-License-Identifier: Apache-2.0
// Freeze coordination (97c7a123): under the batch hold the driver waits for submissions that
// were admitted before the hold, reads only, and never cancels or alters them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { drainBatch, hostedQueueEntries } from '../scripts/bench-t3code/drain.mjs';

const harness = ({ runs = [[]], queues = [[]] } = {}) => {
  let clock = 0,
    r = 0,
    q = 0;
  const said = [];
  const reads = { runs: 0, queue: 0 };
  return {
    said,
    reads,
    options: {
      key: 'n3-r1',
      runs: async () => {
        reads.runs++;
        return runs[Math.min(r++, runs.length - 1)];
      },
      queue: async () => {
        reads.queue++;
        const next = queues[Math.min(q++, queues.length - 1)];
        if (next instanceof Error) throw next;
        return next;
      },
      deadlineMs: 10 * 60_000,
      pauseMs: 60_000,
      say: line => said.push(line),
      wait: async ms => {
        clock += ms;
      },
      now: () => clock,
    },
  };
};

test('an admitted submission that is still queued holds the drain until it finishes', async () => {
  const h = harness({ queues: [['checking 1111aaaa'], ['ready 1111aaaa'], []] });
  assert.equal(await drainBatch(h.options), true);
  assert.equal(h.reads.queue, 3, 'one bounded read per poll, none after it empties');
  assert.equal(h.said.length, 2);
  assert.match(h.said[0], /1 admitted hosted submission\(s\) not finished \(checking 1111aaaa\)/);
  assert.doesNotMatch(h.said[0], /nanthai-forge run/);
});

test('workflow runs and admitted submissions are both waited for', async () => {
  const h = harness({
    runs: [[{ workflowName: 'forge-check' }], []],
    queues: [['queued 2222bbbb'], ['queued 2222bbbb'], []],
  });
  assert.equal(await drainBatch(h.options), true);
  assert.match(
    h.said[0],
    /1 nanthai-forge run\(s\) still in flight \(forge-check\); 1 admitted hosted submission/,
  );
});

test('a queue that never empties times out: the caller releases the hold, nothing is cancelled', async () => {
  const h = harness({ queues: [['checking 3333cccc']] });
  assert.equal(await drainBatch(h.options), false);
  // Only reads happened (the injected collaborators have no write path), and the entry is
  // still listed: its Lane and work were left to finish.
  assert.ok(h.reads.queue > 1);
  assert.equal((await h.options.queue()).length, 1);
});

test('an unreadable queue is not treated as empty', async () => {
  const h = harness({ queues: [new Error('boom'), []] });
  assert.equal(await drainBatch(h.options), true);
  assert.match(h.said[0], /unreadable: boom/);
});

test('hostedQueueEntries reads one queue page and counts unlisted entries', async () => {
  const calls = [];
  const exec = async (node, args) => {
    calls.push([node, args]);
    return {
      stdout:
        'progress\n' +
        JSON.stringify({
          result: {
            total: 3,
            listed: 2,
            more: true,
            entries: [{ phase: 'checking', laneId: 'aaaaaaaa-1' }, { laneId: 'bbbbbbbb-2' }],
          },
        }) +
        '\n',
    };
  };
  const root = (await import('node:os')).tmpdir() + '/bench-drain-anchor';
  const labels = await hostedQueueEntries(
    { cli: '/cli.mjs', url: 'https://x.invalid', projectId: 'p', root },
    exec,
  );
  assert.deepEqual(labels, ['checking aaaaaaaa', 'queued bbbbbbbb', 'queued (not listed)']);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1].slice(0, 4), ['/cli.mjs', 'agent', root, 'queue']);
  assert.deepEqual(JSON.parse(calls[0][1][4]), { url: 'https://x.invalid', projectId: 'p', limit: 20 });
  await assert.rejects(
    hostedQueueEntries({ cli: 'c', url: 'u', projectId: 'p', root }, async () => ({
      stdout: '{"result":{}}\n',
    })),
    /no entries/,
  );
});
