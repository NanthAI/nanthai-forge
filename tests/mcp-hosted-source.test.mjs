// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from '../dist/hash.js';
import { registerAgentWorkflow } from '../dist/mcp-agent-workflow.js';
import { agentFixture } from './hosted-agent-fixture.mjs';
function fixture(t) {
  const s = agentFixture(t);
  const content = new Map([
    ['a.ts', [Buffer.from('export const saved = 1;\nsecond line\n'), 'executable']],
    ['binary', [Buffer.from([0, 255, 5]), 'file']],
    ['link', [Buffer.from('../outside'), 'symlink']],
    ['omitted.txt', [Buffer.from('Saved sparse omission\n'), 'file']],
    ['large.txt', [Buffer.alloc(1024 * 1024 + 1, 97), 'file']],
  ]);
  const files = [...content]
    .map(([path, [bytes, mode]]) => {
      const blob = digest(bytes);
      s.objects.set(blob, bytes);
      return { path, blob, mode };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  const bytes = Buffer.from(
    JSON.stringify({
      schema: 1,
      kind: 'forge-source-state',
      parents: [],
      files,
      message: 'Synthetic',
      at: '2026-01-01T00:00:00.000Z',
    }),
  );
  s.lane.head = digest(bytes);
  s.objects.set(s.lane.head, bytes);
  const tools = new Map();
  const close = registerAgentWorkflow(
    {
      registerTool(name, schema, call) {
        tools.set(name, { schema, call });
      },
    },
    s.root,
    s.transport(),
  );
  t.after(close);
  const call = async (name, input) => {
    const response = await tools.get(name).call(input);
    return { error: response.isError, ...JSON.parse(response.content[0].text) };
  };
  return { ...s, content, call };
}
test('saved source reads return exact Lane/State/blob pins without Work, graph or extra file hydration', async t => {
  const s = fixture(t);
  const selected = await s.call('forge_current', { laneId: s.lane.laneId });
  assert.deepEqual(selected.sourceContext, s.lane);
  assert.deepEqual(
    s.calls.map(call => call.name),
    ['projectHostedLanes:select'],
  );
  const expected = { head: s.lane.head, version: s.lane.version, sourceVersion: s.lane.sourceVersion };
  const shown = await s.call('forge_review', {
    command: { action: 'show', laneId: s.lane.laneId, expected, path: 'a.ts' },
  });
  assert(!shown.error);
  assert.deepEqual(shown.sourceContext, s.lane);
  assert.equal(shown.result.state, expected.head);
  assert.equal(shown.result.blob, digest(s.content.get('a.ts')[0]));
  assert.equal(shown.result.content, s.content.get('a.ts')[0].toString());
  assert.equal(shown.result.mode, 'executable');
  assert.equal(shown.result.encoding, 'utf8');
  assert(!existsSync(s.root));
  for (const [path, [bytes]] of s.content)
    assert.equal(existsSync(join(`${s.root}.forge-client`, 'objects', digest(bytes))), path === 'a.ts');
  assert(s.calls.every(call => call.name === 'projectHostedLanes:select'));
  const lines = await s.call('forge_source', {
    laneId: s.lane.laneId,
    expected,
    file: 'a.ts',
    start: 2,
    end: 2,
  });
  assert.equal(lines.results[0].text, 'second line');
  assert.equal(lines.sourceId, expected.head);
  assert.equal(lines.results[0].digest, shown.result.blob);
});

test('source never substitutes working edits, sparse omissions or symlink targets for saved bytes', async t => {
  const s = fixture(t);
  await s.transport().dispatch('open', { laneId: s.lane.laneId, paths: ['a.ts'] });
  writeFileSync(join(s.root, 'a.ts'), 'Unsaved local draft');
  assert(!existsSync(join(s.root, 'omitted.txt')));
  const shown = await s.call('forge_review', { command: { action: 'show', path: 'a.ts' } });
  assert.equal(shown.result.content, s.content.get('a.ts')[0].toString());
  const omitted = await s.call('forge_source', { file: 'omitted.txt' });
  assert.equal(omitted.results[0].text, 'Saved sparse omission\n');
  const link = await s.call('forge_review', { command: { action: 'show', path: 'link' } });
  assert.equal(link.result.mode, 'symlink');
  assert.equal(link.result.content, '../outside');
  assert.equal(readFileSync(join(s.root, 'a.ts'), 'utf8'), 'Unsaved local draft');
  assert(!existsSync(join(s.root, 'omitted.txt')));
});

test('binary and large-file reads preserve native show force behavior and explicit pins', async t => {
  const s = fixture(t);
  assert.equal(
    (await s.call('forge_review', { command: { action: 'show', laneId: s.lane.laneId, path: 'binary' } }))
      .error.code,
    'BINARY_FILE',
  );
  const binary = await s.call('forge_review', {
    command: { action: 'show', laneId: s.lane.laneId, path: 'binary', force: true },
  });
  assert.equal(binary.result.encoding, 'base64');
  assert.deepEqual(Buffer.from(binary.result.content, 'base64'), s.content.get('binary')[0]);
  assert.equal(
    (await s.call('forge_source', { laneId: s.lane.laneId, file: 'binary' })).error.code,
    'BINARY_FILE',
  );
  assert.equal(
    (await s.call('forge_review', { command: { action: 'show', laneId: s.lane.laneId, path: 'large.txt' } }))
      .error.code,
    'FILE_LIMIT',
  );
  assert.equal(
    (
      await s.call('forge_review', {
        command: { action: 'show', laneId: s.lane.laneId, path: 'large.txt', force: true },
      })
    ).result.size,
    1024 * 1024 + 1,
  );
});

test('expected source movement, foreign selections, missing files and invalid paths fail explicitly', async t => {
  const s = fixture(t),
    expected = { head: 'f'.repeat(64), version: 0, sourceVersion: 0 };
  assert.equal(
    (await s.call('forge_source', { laneId: s.lane.laneId, expected, file: 'a.ts' })).error.code,
    'WORK_STALE',
  );
  assert.equal(
    (await s.call('forge_source', { laneId: s.lane.laneId, file: 'missing' })).error.code,
    'NOT_FOUND',
  );
  assert.equal(
    (await s.call('forge_source', { laneId: s.lane.laneId, file: '../outside' })).error.code,
    'BAD_ARGUMENT',
  );
  assert.equal((await s.call('forge_current', {})).error.code, 'BAD_ARGUMENT');
  assert.equal(
    (await s.call('forge_current', { laneId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })).error.code,
    'PROJECT_UNAVAILABLE',
  );
  s.lane.projectId = 'foreign';
  assert.equal((await s.call('forge_current', { laneId: s.lane.laneId })).error.code, 'PROJECT_UNAVAILABLE');
});

test('cache hits recheck current authority and never return corrupt or redirected cache bytes', async t => {
  const s = fixture(t),
    command = { action: 'show', laneId: s.lane.laneId, path: 'a.ts' };
  await s.call('forge_review', { command });
  s.allow(false);
  assert.equal((await s.call('forge_review', { command })).error.code, 'PROJECT_UNAVAILABLE');
  s.allow(true);
  const path = join(`${s.root}.forge-client`, 'objects', digest(s.content.get('a.ts')[0]));
  writeFileSync(path, 'Corrupt');
  assert.equal(
    (await s.call('forge_review', { command })).result.content,
    s.content.get('a.ts')[0].toString(),
  );
  const original = s.exchange.downloadBatch;
  writeFileSync(path, 'Corrupt again');
  s.exchange.downloadBatch = async pins => pins.map(() => Buffer.from('Wrong bytes'));
  assert.equal((await s.call('forge_review', { command })).error.code, 'INVALID_NATIVE_SOURCE');
  s.exchange.downloadBatch = original;
});

test('revocation or Lane movement during source IO fails before returning bytes', async t => {
  for (const change of ['revoke', 'move']) {
    const s = fixture(t),
      original = s.exchange.downloadBatch;
    s.exchange.downloadBatch = async pins => {
      const bytes = await original(pins);
      if (pins.some(pin => pin.sha256 === digest(s.content.get('a.ts')[0]))) {
        if (change === 'revoke') s.allow(false);
        else s.lane.sourceVersion++;
      }
      return bytes;
    };
    assert.equal(
      (await s.call('forge_source', { laneId: s.lane.laneId, file: 'a.ts' })).error.code,
      change === 'revoke' ? 'PROJECT_UNAVAILABLE' : 'WORK_STALE',
    );
  }
});

test('source cache paths cannot redirect reads to unrelated files', async t => {
  const s = fixture(t),
    other = join(s.root, '..', 'other');
  mkdirSync(other);
  symlinkSync(other, `${s.root}.forge-client`);
  assert.equal(
    (await s.call('forge_source', { laneId: s.lane.laneId, file: 'a.ts' })).error.code,
    'UNSAFE_PATH',
  );
});

test('malformed selected State metadata fails as a protocol error without returning source', async t => {
  const s = fixture(t),
    bytes = Buffer.from('{"schema":100}');
  s.lane.head = digest(bytes);
  s.objects.set(s.lane.head, bytes);
  assert.equal(
    (await s.call('forge_source', { laneId: s.lane.laneId, file: 'a.ts' })).error.code,
    'HOSTED_PROTOCOL_INVALID',
  );
});
