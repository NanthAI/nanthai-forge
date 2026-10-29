// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { buildAgentLinks } from '../dist/agent-links.js';
import { initNative } from '../dist/native-work.js';
import { sourceFilePage } from '../dist/source-file-page.js';
import { updateHostState } from '../dist/host-binding.js';
import { moduleUrl } from './convex-module.mjs';
const routes = await import(moduleUrl('../web/src/shell/location.ts'));
const shellRoutes = await import(moduleUrl('../web/src/shell/route.ts'));
const laneId = '63b67c40-d744-441d-9d7e-e8b5bbde9c52';
const head = 'a'.repeat(64);
const input = {
  laneId,
  head,
  name: 'Demo',
  path: 'src/a b#?.ts',
  line: 42,
  projectUrl: 'https://forge.example/maya/demo',
  projectId: 'p1',
  slug: 'demo',
};
test('hosted links retain exact path, line and saved head; there is no local browser link', () => {
  const links = buildAgentLinks(input);
  const hosted = new URL(links.hosted);
  assert.equal('local' in links, false);
  assert.equal(hosted.hash, '#L42');
  assert.equal(hosted.searchParams.get('head'), head);
  assert.equal(hosted.searchParams.has('laneId'), false);
  assert.equal(links.preferred, links.hosted);
  assert.equal(links.pinned, true);
  const parsed = routes.routeUrlState(hosted.href);
  assert.equal(parsed.searchParams.get('file'), input.path);
  assert.equal(parsed.searchParams.get('line'), '42');
  const unbound = buildAgentLinks({ ...input, projectUrl: undefined });
  assert.equal(unbound.hosted, null);
  assert.equal(unbound.preferred, null);
});
test('save, View, Lane and legacy hosted bindings have usable canonical destinations', () => {
  const save = buildAgentLinks({ ...input, laneId: undefined, save: head });
  assert.equal(routes.routeUrlState(save.hosted).searchParams.get('head'), head);
  const view = buildAgentLinks({ ...input, laneId: undefined, viewId: laneId });
  assert.equal(new URL(view.hosted).searchParams.get('head'), head);
  const lane = buildAgentLinks({ ...input, path: undefined, line: undefined });
  assert.equal(new URL(lane.hosted).pathname, '/maya/demo/code');
  assert.equal(new URL(lane.hosted).searchParams.get('head'), head);
  const legacy = buildAgentLinks({
    ...input,
    owner: 'maya',
    projectUrl: 'https://forge.example/?project=p1',
  });
  assert.match(legacy.hosted, /\/maya\/demo\/code\//);
  assert.equal(routes.routeUrlState(legacy.hosted).searchParams.get('project'), 'p1');
  assert.equal(
    routes.routeUrlState('https://forge.example/maya/demo/code/a.ts#L42').searchParams.get('line'),
    '42',
  );
});
function disk(path) {
  return Object.fromEntries(
    readdirSync(path, { recursive: true, withFileTypes: true })
      .filter(item => item.isFile())
      .map(item => {
        const file = join(item.parentPath, item.name);
        return [relative(path, file), readFileSync(file).toString('base64')];
      }),
  );
}
test('link repeats without changing source, Work, transport, or restoring a cleaned Lane', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-links-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'example.ts'), 'one\ntwo\nthree\n');
  initNative(root);
  const agent = new AgentWorkflow(root),
    store = agent.work.store;
  const lane = (await agent.dispatch({ action: 'start', outcome: 'Synthetic links' })).result;
  updateHostState(store, state => {
    state.binding = {
      projectId: 'p1',
      deployment: 'https://deployment.example',
      projectUrl: input.projectUrl,
      operationId: laneId,
      name: 'Demo',
      visibility: 'private',
      backupId: 'b1',
      autoSync: false,
    };
  });
  rmSync(lane.path, { recursive: true, force: true });
  const originalFetch = globalThis.fetch;
  const previousToken = process.env.FORGE_AUTH_TOKEN;
  process.env.FORGE_AUTH_TOKEN = 'synthetic-token';
  t.after(() => {
    if (previousToken === undefined) delete process.env.FORGE_AUTH_TOKEN;
    else process.env.FORGE_AUTH_TOKEN = previousToken;
  });
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ status: 'success', value: { handle: 'maya', slug: 'demo', name: 'Demo' } }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const before = disk(root),
    command = { action: 'link', laneId: lane.laneId, path: 'example.ts', line: 2 };
  const first = await agent.dispatch(command),
    second = await agent.dispatch(command);
  assert.deepEqual(first, second);
  assert.deepEqual(disk(root), before);
  assert.equal(first.result.head, lane.head);
  assert.equal(new URL(first.result.hosted).searchParams.get('head'), lane.head);
  const saved = await agent.dispatch({ action: 'link', save: lane.head, path: 'example.ts', line: 2 });
  assert.equal(routes.routeUrlState(saved.result.hosted).searchParams.get('head'), lane.head);
  for (const bad of [
    { laneId: lane.laneId, save: lane.head },
    { laneId: lane.laneId, path: '../secret' },
    { laneId: lane.laneId, line: 2 },
  ])
    await assert.rejects(agent.dispatch({ action: 'link', ...bad }));
  assert.deepEqual(disk(root), before);
});
test('source line pages preserve UTF-8 and reject invalid lines', () => {
  const bytes = Buffer.from(Array.from({ length: 200 }, (_, i) => `line ${i + 1} 💡`).join('\n'));
  const page = sourceFilePage(bytes, 'src/a.ts', 42);
  assert.equal(page.startLine, 42);
  assert.equal(page.endLine, 121);
  assert.equal(page.totalLines, 200);
  assert.match(page.text, /^line 42 💡/);
  for (const line of [0, -1, 201, 1.5, Infinity]) assert.throws(() => sourceFilePage(bytes, 'a', line));
  assert.throws(() => sourceFilePage(Buffer.from([255]), 'a', 1));
});

test('generated hosted URL uses the app codec and opens Code source at the exact path and line', () => {
  const link = buildAgentLinks({
    ...input,
    owner: 'maya',
    projectUrl: 'https://forge.example/?project=p1',
  }).hosted;
  const decoded = routes.routeUrlState(link);
  assert.equal(new URL(link).pathname, '/maya/demo/code/src/a%20b%23%3F.ts');
  assert.equal(decoded.searchParams.get('project'), 'p1');
  assert.equal(decoded.searchParams.get('projectTab'), 'delivery');
  assert.equal(shellRoutes.hostedTab(decoded.searchParams.get('projectTab')), 'code');
  assert.equal(decoded.searchParams.get('view'), 'source');
  assert.equal(decoded.searchParams.get('file'), input.path);
  assert.equal(decoded.searchParams.get('line'), '42');
  assert.equal(decoded.searchParams.get('head'), head);
  routes.routeMode('hosted');
  routes.projectIdentity('p1', 'maya', 'Demo');
  assert.equal(
    routes.cleanUrl(link, input.projectUrl),
    new URL(link).pathname + new URL(link).search + new URL(link).hash,
  );
  const legacy = 'https://forge.example/projects/demo~p1/code/src/a.ts?head=' + head + '&line=42';
  assert.equal(routes.routeUrlState(legacy).searchParams.get('project'), 'p1');
  assert.match(routes.cleanUrl(legacy, input.projectUrl), /^\/maya\/demo\/code\/src\/a.ts/);
  assert.throws(() => buildAgentLinks({ ...input, projectUrl: 'https://forge.example/?project=p1' }), {
    code: 'HOST_IDENTITY_REQUIRED',
  });
});
test('legacy binding resolves the actual hosted owner without changing local metadata', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-link-owner-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'example.ts'), 'one\ntwo\n');
  initNative(root);
  const agent = new AgentWorkflow(root);
  const lane = (await agent.dispatch({ action: 'start', outcome: 'Synthetic owner lookup' })).result;
  updateHostState(agent.work.store, state => {
    state.binding = {
      projectId: 'p1',
      deployment: 'https://deployment.example',
      projectUrl: 'https://forge.example/?project=p1',
      operationId: laneId,
      name: 'Demo',
      visibility: 'private',
      backupId: 'b1',
      autoSync: false,
    };
  });
  const originalFetch = globalThis.fetch,
    token = process.env.FORGE_AUTH_TOKEN;
  process.env.FORGE_AUTH_TOKEN = 'synthetic-account-token';
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (token === undefined) delete process.env.FORGE_AUTH_TOKEN;
    else process.env.FORGE_AUTH_TOKEN = token;
  });
  let queries = 0;
  globalThis.fetch = async (_url, init) => {
    assert.equal(JSON.parse(init.body).path, 'urlProjects:resolve');
    queries++;
    return new Response(
      JSON.stringify({ status: 'success', value: { handle: 'maya', slug: 'demo', name: 'Demo' } }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  };
  const before = disk(root);
  const response = await agent.dispatch({ action: 'link', laneId: lane.laneId, path: 'example.ts', line: 2 });
  assert.match(response.result.hosted, /^https:\/\/forge.example\/maya\/demo\/code\/example.ts/);
  assert.equal(queries, 1);
  assert.deepEqual(disk(root), before);
});

test('optional receipt links do not change checkpoint success when hosted identity is unavailable', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-link-receipt-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'example.ts'), 'one\n');
  initNative(root);
  const agent = new AgentWorkflow(root);
  const lane = (await agent.dispatch({ action: 'start', outcome: 'Synthetic receipt' })).result;
  updateHostState(agent.work.store, state => {
    state.binding = {
      projectId: 'p1',
      deployment: 'https://deployment.example',
      projectUrl: 'https://forge.example/?project=p1',
      operationId: laneId,
      name: 'Demo',
      visibility: 'private',
      backupId: 'b1',
      autoSync: false,
    };
  });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let queries = 0;
  globalThis.fetch = async () => {
    queries++;
    throw new Error('Synthetic offline');
  };
  writeFileSync(join(lane.path, 'example.ts'), 'two\n');
  const saved = await agent.dispatch({
    action: 'checkpoint',
    laneId: lane.laneId,
    message: 'Save while offline',
  });
  assert.equal(saved.result.laneId, lane.laneId);
  assert.ok(saved.result.head);
  assert.equal(saved.result.links.error.code, 'HOST_IDENTITY_UNAVAILABLE');
  assert.equal(queries, 0, 'durable receipts must not wait for network identity resolution');
});
