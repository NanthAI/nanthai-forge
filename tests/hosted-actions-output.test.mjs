// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { actionsFixture } from './hosted-actions-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { runHostedActionsJob } from '../dist/hosted-actions-output.js';
import { HostedActionsOutputSpool } from '../dist/hosted-actions-spool.js';
import { hostedOutputPublisher } from '../dist/hosted-output-transfer.js';
import { outputStreamId, signOutput, outputMessage } from '../dist/hosted-check-output.js';
import { code } from './hosted-checks-fixture.mjs';
const output = await import(moduleUrl('../convex/projectHostedOutputStore.ts'));
const read = await import(moduleUrl('../convex/projectHostedOutputRead.ts'));
const key = 'synthetic-output-collector-only';
async function fixture() {
  const s = await actionsFixture(),
    owner = randomUUID(),
    c = await s.store.control({ kind: 'claim', owner }),
    token = c.mapping.lease.token;
  for (const cmd of [
    { kind: 'export', export: s.exported },
    { kind: 'published' },
    { kind: 'reserve', recovery: false },
    { kind: 'lookup', run: 123, empty: false },
    { kind: 'release' },
  ])
    await s.store.control({ ...cmd, owner, token });
  const run = (
    await s.control(s.input.id, {
      kind: 'observe',
      owner: s.input.lease.owner,
      token: s.input.lease.token,
      result: { status: 'accepted', executionId: '123' },
    })
  ).run;
  const bytes = new Map(),
    counters = { puts: 0, commits: 0, argumentBytes: 0 };
  let disconnected = false;
  const publisher = hostedOutputPublisher(run, key, {
    async prepare(message) {
      return {
        object: message.body.chunk.object,
        target: { kind: 'r2', url: message.body.chunk.object.sha256, headers: {} },
      };
    },
    async put(url, _headers, data) {
      counters.puts++;
      if (disconnected) throw new Error('synthetic offline');
      bytes.set(url, Buffer.from(data));
      return { status: 200 };
    },
    async commit(message, signature) {
      if (disconnected) throw new Error('synthetic offline');
      counters.commits++;
      counters.argumentBytes += Buffer.byteLength(JSON.stringify(message));
      assert(!JSON.stringify(message).includes('first-live-line'));
      return s.run('actionsOutputCommit', (ctx, input) => output.commitHostedOutput(ctx, input, () => key), {
        projectId: s.projectId,
        message,
        signature,
      });
    },
  });
  const root = await mkdtemp(join(tmpdir(), 'forge-actions-output-'));
  const spool = new HostedActionsOutputSpool(
    join(root, 'spool'),
    publisher.sink(async () => {}),
  );
  const job = {
    id: 987,
    runId: 123,
    commit: s.exported.commit,
    head: run.request.expectedHead,
    shard: 0,
    attempt: 0,
  };
  const input = {
    run,
    mapping: s.mapping(),
    job,
    cwd: root,
    environment: {},
    redaction: { secrets: ['synthetic-private-value'], paths: [root] },
    sink: () => spool.sink(),
    command: [process.execPath, '-e', "console.log('first-live-line synthetic-private-value')"],
  };
  const chunks = () =>
    s
      .call('actionsOutputPage', read.chunks, { projectId: s.projectId, runId: run.id, after: 0 })
      .then(JSON.parse);
  return {
    ...s,
    check: run,
    root,
    spool,
    input,
    bytes,
    counters,
    chunks,
    offline: value => {
      disconnected = value;
    },
  };
}
test('trusted runner publishes redacted H12 chunks while command is alive, before exit or provider logs', async () => {
  const s = await fixture();
  try {
    let observedWhileRunning = false;
    const sink = s.spool.sink();
    s.input.sink = () => ({
      ...sink,
      async publish(chunk, bytes) {
        await sink.publish(chunk, bytes);
        const page = await s.chunks();
        assert(page.page.length > 0);
        assert.equal((await s.status(s.check.id)).status, 'running');
        if (!observedWhileRunning) {
          observedWhileRunning = true;
          await writeFile(join(s.root, 'continue'), 'yes');
        }
      },
    });
    s.input.command = [
      process.execPath,
      '-e',
      `const fs=require('node:fs'); console.log('first-live-line synthetic-private-value');
      const deadline=Date.now()+5000; const wait=setInterval(()=>{if(fs.existsSync('continue')){clearInterval(wait);console.error('last-line');}
      else if(Date.now()>deadline){clearInterval(wait);process.exitCode=9;}},10);`,
    ];
    const result = await runHostedActionsJob(s.input);
    assert.equal(result.exitCode, 0);
    assert(observedWhileRunning);
    assert.equal(result.seals.length, 2);
    const text = [...s.bytes.values()].map(b => b.toString()).join('');
    assert(text.includes('first-live-line [redacted]'));
    assert(!text.includes('synthetic-private-value'));
    assert.equal((await s.chunks()).page.length, 2);
    assert(s.counters.argumentBytes > 0);
    console.log('Actions live fixture metadata:', JSON.stringify(s.counters));
  } finally {
    await rm(s.root, { recursive: true, force: true });
  }
});
test('offline spool preserves exact chunks and seals; a new collector replays duplicates and recovers gaps', async () => {
  const s = await fixture();
  try {
    s.offline(true);
    const result = await runHostedActionsJob(s.input);
    assert.equal(result.exitCode, 0);
    assert(s.spool.pending);
    assert.equal((await s.chunks()).page.length, 0);
    s.offline(false);
    // Reconstruct fixed publisher from retained H12 messages, without command rerun.
    const sink = {
      async publish(chunk, bytes) {
        s.bytes.set(chunk.object.sha256, Buffer.from(bytes));
        const message = outputMessage(s.check, { kind: 'chunk', chunk });
        await s.run('actionsOutputReplay', (ctx, input) => output.commitHostedOutput(ctx, input, () => key), {
          projectId: s.projectId,
          message,
          signature: signOutput(message, key),
        });
      },
      async seal(seal) {
        const message = outputMessage(s.check, { kind: 'seal', seal });
        await s.run('actionsOutputSeal', (ctx, input) => output.commitHostedOutput(ctx, input, () => key), {
          projectId: s.projectId,
          message,
          signature: signOutput(message, key),
        });
      },
    };
    const reconnect = new HostedActionsOutputSpool(join(s.root, 'spool'), sink);
    assert.deepEqual(await reconnect.replay(), { pending: false });
    const first = await s.chunks();
    assert(first.page.length > 0);
    await reconnect.replay();
    assert.deepEqual(await s.chunks(), first);
    const chunk = first.page[0].chunk,
      streamId = outputStreamId(chunk.stream);
    assert.equal(first.page[0].streamId, streamId);
    const disk = JSON.parse(
      await readFile(join(s.root, 'spool', `${streamId}-${chunk.sequence}.chunk`), 'utf8'),
    );
    disk.bytes = Buffer.from('corrupt').toString('base64');
    await writeFile(join(s.root, 'spool', `${streamId}-${chunk.sequence}.chunk`), JSON.stringify(disk));
    await assert.rejects(reconnect.replay(), code('R2_OBJECT_CHECKSUM_MISMATCH'));
  } finally {
    await rm(s.root, { recursive: true, force: true });
  }
});
for (const [pin, value] of [
  ['head', 'f'.repeat(64)],
  ['commit', '2'.repeat(40)],
  ['runId', 456],
  ['shard', 5],
])
  test(`stale live-output ${pin} is rejected before spawning project code`, async () => {
    const s = await fixture();
    try {
      s.input.job[pin] = value;
      s.input.command = ['/nonexistent-synthetic-command'];
      await assert.rejects(runHostedActionsJob(s.input), code('EVIDENCE_CHANGED'));
      assert.equal(s.counters.puts, 0);
    } finally {
      await rm(s.root, { recursive: true, force: true });
    }
  });
