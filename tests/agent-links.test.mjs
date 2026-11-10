// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentLinks } from '../dist/agent-links.js';
import { sourceFilePage } from '../dist/source-file-page.js';
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
