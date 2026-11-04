// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { digest } from '../dist/hash.js';
import { showHostedSource } from '../dist/mcp-hosted-source.js';
import { hostedShowCli } from '../dist/hosted-show-cli.js';
import { hostedAgentCli } from '../dist/hosted-agent-cli.js';
import { registerHostedAgentWorkflow } from '../dist/mcp-hosted-agent.js';
function fixture(t, count = 3) {
  const f = agentFixture(t);
  const put = bytes => {
    const id = digest(bytes);
    f.objects.set(id, bytes);
    return id;
  };
  const state = version =>
    put(
      Buffer.from(
        JSON.stringify({
          schema: 1,
          kind: 'forge-source-state',
          parents: [],
          files: Array.from({ length: count }, (_, i) => ({
            path: `src/${String(i).padStart(5, '0')}.ts`,
            blob: put(Buffer.from(`export const value${i} = '${version}';\n`.repeat(40))),
            mode: 'file',
          })),
          at: '2026-01-01T00:00:00.000Z',
          message: 'Synthetic',
        }),
      ),
    );
  f.lane.base.head = state('base');
  f.lane.head = state('saved');
  f.candidate.result.head = f.lane.head;
  return f;
}
for (const count of [3000, 29000])
  test(`${count}-file hosted CLI diff is pinned, bounded and page-batched`, async t => {
    const f = fixture(t, count),
      transport = f.transport();
    const command = { laneId: f.lane.laneId, byteBudget: 4096 };
    const started = performance.now(),
      beforeRss = process.memoryUsage().rss;
    const response = await hostedAgentCli(f.root, 'diff', command, f.address, transport);
    const result = response.result;
    const extraRss = process.memoryUsage().rss - beforeRss;
    assert(extraRss < 256 * 1024 * 1024, `bounded manifest/source working memory: ${extraRss}`);
    t.diagnostic(
      `diff ${count}: ${(performance.now() - started).toFixed(1)} ms, ${extraRss} additional RSS bytes`,
    );
    assert.equal(result.head, f.lane.head);
    assert.equal(result.base, f.lane.base.head);
    assert.equal(result.total, count);
    assert(result.nextCursor && result.truncated);
    assert(result.items.length > 0);
    assert(result.items.some(item => item.hunks?.length));
    assert(result.cost.sourceBytes <= command.byteBudget);
    assert(result.cost.outputBytes <= command.byteBudget);
    assert.equal(f.calls.filter(c => c.name === 'projectHostedLanes:select').length, 2);
    const pages = f.calls.filter(c => c.name === 'projectObjectDownloads:lanePage');
    assert.equal(pages.length, 2, 'one State pair page and one selected blob metadata page');
    assert(pages.every(c => c.args.digests.length <= 100));
    assert(
      f.calls.every(c => ['projectHostedLanes:select', 'projectObjectDownloads:lanePage'].includes(c.name)),
    );
    const pinned = result.head;
    f.lane.head = f.lane.base.head;
    const continued = await transport.dispatch('diff', { ...command, cursor: result.nextCursor });
    assert.equal(continued.result.head, pinned, 'a save cannot substitute new source into continuation');
    assert.equal(
      continued.result.items[0].path,
      `src/${String(result.nextCursor.offset).padStart(5, '0')}.ts`,
    );
    f.allow(false);
    await assert.rejects(transport.dispatch('diff', command), e => e.code === 'PROJECT_UNAVAILABLE');
    t.diagnostic(
      `${count}: ${result.cost.manifestBytes} manifest bytes; ${result.cost.sourceBytes} selected source bytes; ${pages.length} metadata pages`,
    );
  });
test('diff reports an oversized file without reading its bytes', async t => {
  const f = fixture(t, 1);
  const result = (await f.transport().dispatch('diff', { laneId: f.lane.laneId, byteBudget: 1024 })).result;
  assert.equal(result.items.length, 0);
  assert.equal(result.omitted.length, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.cost.sourceBytes, 0);
  assert(result.omitted[0].requiredByteBudget > 1024);
});
test('CLI and MCP show exact Candidate/State bytes, with no revision substitution and fresh access on cache hits', async t => {
  const f = fixture(t, 1),
    transport = f.transport(),
    state = f.lane.head;
  const selected = { state, path: 'src/00000.ts' };
  const first = await showHostedSource(transport, { ...selected, action: 'show' });
  assert.equal(first.result.state, state);
  assert.match(first.result.content, /saved/);
  f.lane.head = f.lane.base.head;
  const second = await showHostedSource(transport, { ...selected, action: 'show' });
  assert.equal(second.result.content, first.result.content);
  let stdout;
  await hostedShowCli(
    f.root,
    { candidateId: f.candidate.id, path: selected.path },
    f.address,
    transport,
    b => {
      stdout = b.toString();
    },
  );
  assert.equal(stdout, first.result.content);
  const tools = new Map();
  const close = registerHostedAgentWorkflow(
    {
      registerTool(name, options, call) {
        tools.set(name, { ...options, call });
      },
    },
    transport,
  );
  t.after(close);
  const reply = await tools.get('forge_review').call({ command: { action: 'show', ...selected } });
  assert.equal(JSON.parse(reply.content[0].text).result.state, state);
  assert(
    tools.get('forge_review').inputSchema.command.safeParse({ action: 'diff', laneId: f.lane.laneId })
      .success,
  );
  assert(
    tools
      .get('forge_review')
      .inputSchema.command.safeParse({ action: 'peers', laneId: f.lane.laneId, path: selected.path }).success,
  );
  const descriptions = [...tools.values()].reduce((n, tool) => n + tool.description.length, 0);
  assert(descriptions <= 3963, `total description characters: ${descriptions}`);
  f.allow(false);
  await assert.rejects(
    showHostedSource(transport, { ...selected, action: 'show' }),
    e => e.code === 'PROJECT_UNAVAILABLE',
  );
  f.allow(true);
  await assert.rejects(
    showHostedSource(transport, { action: 'show', state: 'a'.repeat(64), path: selected.path }),
    e => e.code === 'SOURCE_UNAVAILABLE',
  );
});

test('invalid hosted read parameters fail with a structured error before any server call', async t => {
  const f = fixture(t, 1),
    transport = f.transport();
  for (const [action, command] of [
    ['diff', { byteBudget: 0 }],
    ['diff', { unknown: 'private' }],
    ['peers', { path: '../outside' }],
    ['peers', { detail: 'yes' }],
  ])
    await assert.rejects(transport.dispatch(action, command), error => error.code === 'BAD_ARGUMENT');
  assert.equal(f.calls.length, 0);
});
