// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { HostedAgentJournal } from '../dist/hosted-agent-journal.js';
import { guideHostedSync } from '../dist/hosted-agent-resolution.js';
import { saveBytes } from '../dist/hosted-save.js';
import { digest } from '../dist/hash.js';
test('guided conflict response caps paths and inline bytes while retaining every editable conflict file', async t => {
  const s = agentFixture(t);
  const put = value => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(saveBytes(value)),
      pin = { sha256: digest(bytes), size: bytes.length };
    s.objects.set(pin.sha256, bytes);
    return pin;
  };
  const huge = put(Buffer.alloc(140 * 1024, 65)),
    small = put(Buffer.from('<<<<<<< lane\nleft\n=======\nright\n>>>>>>> target\n'));
  const files = Array.from({ length: 125 }, (_, i) => ({
    path: `conflict-${String(i).padStart(3, '0')}.txt`,
    blob: i ? small.sha256 : huge.sha256,
    mode: 'file',
  }));
  const state = put({
    schema: 1,
    kind: 'forge-source-state',
    parents: [],
    files,
    message: 'Synthetic conflicts',
    at: '2026-01-01T00:00:00.000Z',
  });
  s.lane.head = state.sha256;
  const mutation = s.exchange.client.mutation;
  s.exchange.client.mutation = async (ref, args) =>
    getFunctionName(ref) === 'projectObjectDownloads:describe'
      ? args.digests.map(id => ({
          digest: id,
          size: s.objects.get(id).length,
          location: 'r2',
          url: `https://fixture.invalid/${id}`,
        }))
      : mutation(ref, args);
  t.mock.method(globalThis, 'fetch', async url => {
    const bytes = s.objects.get(new URL(url).pathname.slice(1));
    assert(bytes, 'only synthetic conflict objects');
    return new Response(bytes);
  });
  let next = null;
  for (const paths of [files.slice(100), files.slice(0, 100)])
    next = put({
      schema: 1,
      kind: 'forge-hosted-compose-conflicts',
      left: s.main.head,
      right: s.main.head,
      paths: paths.map(file => ({ path: file.path, base: null, left: file, right: file })),
      next,
    });
  const value = {
    outcome: {
      status: 'completed',
      result: {
        schema: 1,
        operationId: randomUUID(),
        status: 'conflict',
        lane: s.lane,
        from: null,
        resolution: {
          candidateId: null,
          conflicts: next,
          left: s.main.head,
          right: s.main.head,
          draftHead: state.sha256,
          status: 'pending',
        },
        at: '2026-01-01T00:00:00.000Z',
      },
    },
  };
  const result = await guideHostedSync(
    {
      root: s.root,
      address: s.address,
      exchange: s.exchange,
      journal: new HostedAgentJournal(s.root, s.address, 'owner', 'sync', {}),
      query: async () => s.lane,
    },
    value,
  );
  assert.equal(result.conflict.paths.length, 100);
  assert.equal(result.conflict.more, 25);
  assert.equal(result.conflict.files[0].content, null, 'large bytes stay in the editable file');
  assert(
    result.conflict.files.reduce((n, file) => n + Buffer.byteLength(file.content ?? ''), 0) <= 128 * 1024,
  );
  assert(existsSync(join(result.conflict.root, files.at(-1).path)));
  assert.equal(readFileSync(join(result.conflict.root, files[0].path)).length, huge.size);
});
