// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
const r = await import(moduleUrl('../web/src/shell/location.ts'));
const id = '63b67c40-d744-441d-9d7e-e8b5bbde9c52';
const base = 'https://forge.example/';
test('short Work IDs round trip without a lossy prefix lookup', () => {
  for (const kind of ['i', 'l', 'v']) {
    const short = r.shortId(id, kind);
    assert.equal(short.length, 24);
    assert.equal(r.longId(short), id);
  }
  assert.equal(r.longId('v-not-valid'), 'v-not-valid');
  assert.equal(r.shortId('fixture', 'v'), 'fixture');
});
test('hosted legacy collection URLs redirect into the selected project and retain Intents', () => {
  r.routeMode('hosted');
  r.projectIdentity('p1', 'maya', 'Forge');
  const clean = r.cleanUrl('?surface=projects&collection=projects&project=p1&tab=intents', base);
  assert.equal(clean, '/maya/forge/intents');
  const state = r.routeUrlState(new URL(clean, base).href);
  assert.equal(state.searchParams.get('project'), 'p1');
  assert.equal(state.searchParams.get('projectTab'), 'intent');
});
test('all hosted destinations have canonical homes and old names redirect after rename', () => {
  r.routeMode('hosted');
  r.projectIdentity('p1', 'maya', 'Forge');
  for (const [section, path] of [
    ['overview', ''],
    ['intent', '/intents'],
    ['lanes', '/lanes'],
    ['views', '/intents'],
    ['planning', '/planning'],
    ['coordination', '/activity'],
    ['activity', '/activity'],
    ['delivery', '/code'],
    ['sharing', '/settings/general'],
    ['agents', '/settings/agents'],
    ['backups', '/settings/backups'],
    ['settings', '/settings/general'],
  ]) {
    assert.equal(r.cleanUrl(`?project=p1&projectTab=${section}`, base), '/maya/forge' + path);
  }
  r.projectIdentity('p1', 'maya', 'New name');
  assert.equal(r.cleanUrl('/maya/forge~p1/lanes', base), '/maya/new-name/lanes');
});
test('legacy account surfaces have a single project-list home', () => {
  r.routeMode('hosted');
  for (const surface of ['projects', 'explore', 'agents'])
    assert.equal(r.cleanUrl(`?surface=${surface}&collection=saved`, base), '/');
});
test('local deep links, source paths and pins survive canonical routing', () => {
  r.routeMode('local');
  r.localIdentity('forge');
  const clean = r.cleanUrl(`?tab=intents&lane=${id}`, base);
  assert.equal(clean, `/local/forge/lanes/${r.shortId(id, 'l')}`);
  assert.equal(r.routeUrlState(new URL(clean, base).href).searchParams.get('lane'), id);
  const code = r.cleanUrl('?tab=code&file=src/a%20b.ts&state=abc&line=9', base);
  assert.match(code, /\/code\/src\/a%20b.ts/);
  const state = r.routeUrlState(new URL(code, base).href);
  assert.equal(state.searchParams.get('file'), 'src/a b.ts');
  assert.equal(state.searchParams.get('state'), 'abc');
  assert.equal(state.searchParams.get('line'), '9');
});
test('decoded state can change destinations and clear drills without old path winning', () => {
  r.routeMode('hosted');
  const url = r.routeUrlState(new URL('/maya/new-name~p1/lanes/' + r.shortId(id, 'l'), base).href);
  url.searchParams.set('projectTab', 'intent');
  url.searchParams.delete('lane');
  assert.equal(r.cleanUrl(url, base), '/maya/new-name/intents');
});
test('external links and repository source routes keep their authority and identity', () => {
  assert.equal(r.cleanUrl('https://elsewhere.example/a', base), 'https://elsewhere.example/a');
  assert.equal(r.cleanUrl('?codescape=c1&state=abc', base), 'https://forge.example/?codescape=c1&state=abc');
});

test('primary hrefs leave the active View and preserve the project when opened in a new tab', () => {
  r.routeMode('hosted');
  r.projectIdentity('p1', 'maya', 'Forge');
  const current = `https://forge.example/maya/forge~p1/views/${r.shortId(id, 'v')}`;
  for (const [tab, path] of [
    ['now', ''],
    ['intents', '/intents'],
    ['code', '/code'],
    ['settings', '/settings/general'],
  ])
    assert.equal(r.projectNavigationHref(tab, current), '/maya/forge' + path);
});

test('legacy query links from clean drills replace the old drill instead of retaining it', () => {
  r.routeMode('local');
  r.localIdentity('forge');
  const lane = `https://forge.example/local/forge/lanes/${r.shortId(id, 'l')}`;
  assert.equal(r.cleanUrl(`?tab=intents&intent=${id}`, lane), `/local/forge/intents/${r.shortId(id, 'i')}`);
  assert.equal(r.cleanUrl('?tab=now&activity=1', lane), '/local/forge/activity');
  r.routeMode('hosted');
  r.projectIdentity('p1', 'maya', 'Forge');
  const view = `https://forge.example/maya/forge~p1/views/${r.shortId(id, 'v')}`;
  assert.equal(r.cleanUrl('?projectTab=intent', view), '/maya/forge/intents');
});

test('Code keeps its selected source Lane and revision through primary navigation', () => {
  r.routeMode('local');
  r.localIdentity('forge');
  const code = r.cleanUrl(`?tab=code&file=app.ts&state=source-head&laneId=${id}`, base);
  const current = new URL(code, base).href;
  assert.equal(r.routeUrlState(current).searchParams.get('laneId'), id);
  for (const tab of ['now', 'intents', 'code', 'settings']) {
    const next = r.projectNavigationHref(tab, current);
    assert.equal(r.routeUrlState(new URL(next, base).href).searchParams.get('laneId'), id);
    assert.equal(r.routeUrlState(new URL(next, base).href).searchParams.get('state'), 'source-head');
    if (tab === 'intents') assert.match(next, /\/intents\?/);
  }
});

test('account Settings decodes and can navigate back to the project list', () => {
  r.routeMode('hosted');
  const url = r.routeUrlState(new URL('/settings', base).href);
  assert.equal(url.searchParams.get('surface'), 'account');
  url.searchParams.set('surface', 'projects');
  assert.equal(r.cleanUrl(url, base), '/');
  assert.equal(r.cleanUrl('/settings', base), '/settings');
});

test('Settings sections round trip in local and hosted clean URLs without query duplicates', () => {
  for (const mode of ['local', 'hosted']) {
    r.routeMode(mode);
    r.localIdentity('forge');
    r.projectIdentity('p1', 'maya', 'Forge');
    for (const section of [
      'general',
      'agents',
      'autonomy',
      'checks',
      'access',
      'you',
      'appearance',
      'devices',
      'backups',
      'contributions',
      'transfer',
    ]) {
      const url = new URL(base);
      url.searchParams.set(mode === 'local' ? 'tab' : 'projectTab', 'settings');
      if (mode === 'hosted') url.searchParams.set('project', 'p1');
      url.searchParams.set('settingsSection', section);
      const clean = r.cleanUrl(url, base);
      assert.ok(clean.endsWith('/settings/' + section), clean);
      assert.ok(!clean.includes('?'), clean);
      const decoded = r.routeUrlState(new URL(clean, base).href);
      assert.equal(decoded.searchParams.get('settingsSection'), section);
    }
  }
});

test('Work filters, selected diff file and mode survive canonicalization and reload decoding', () => {
  r.routeMode('local');
  const url = new URL(
    r.cleanUrl(`?tab=intents&workPage=lanes&intentFilter=done&diffFile=src%2Fa.ts&diffMode=split`, base),
    base,
  );
  const state = r.routeUrlState(url.href);
  assert.equal(state.searchParams.get('workPage'), 'lanes');
  assert.equal(state.searchParams.get('diffFile'), 'src/a.ts');
  assert.equal(state.searchParams.get('diffMode'), 'split');
  assert.equal(state.searchParams.get('intentFilter'), 'done');
});

test('a changed line anchor wins over a legacy line query', () => {
  assert.equal(
    r
      .routeUrlState('https://forge.example/local/demo/code/a.ts?head=save&line=2#L3')
      .searchParams.get('line'),
    '3',
  );
});

test('shared file links keep the immutable save, checkpoint and exact line anchor', async () => {
  const { savedLink } = await import(moduleUrl('../web/src/shell/ObjectActions.tsx'));
  const previous = globalThis.location;
  globalThis.location = { href: 'https://forge.example/maya/forge~p1/views/v-example?sourceBackup=b1' };
  try {
    r.routeMode('hosted');
    r.projectIdentity('p1', 'maya', 'Forge');
    const link = new URL(savedLink('saved-head', 'src/a b.ts', 18, false, 'b1'));
    assert.equal(link.hash, '#L18');
    const decoded = r.routeUrlState(link.href);
    assert.equal(decoded.searchParams.get('head'), 'saved-head');
    assert.equal(decoded.searchParams.get('sourceBackup'), 'b1');
    assert.equal(decoded.searchParams.get('file'), 'src/a b.ts');
    assert.equal(decoded.searchParams.get('viewId'), null);
    assert.equal(decoded.searchParams.get('line'), '18');
  } finally {
    if (previous === undefined) delete globalThis.location;
    else globalThis.location = previous;
  }
});

test('retired Views list redirects to Intents while View deep links retain their identity', () => {
  for (const path of [
    'https://forge.example/local/forge/views',
    'https://forge.example/maya/forge~p1/views',
  ]) {
    r.routeMode(path.includes('/local/') ? 'local' : 'hosted');
    assert.match(r.cleanUrl(path, path), /\/intents$/);
    const detail = path + '/' + r.shortId(id, 'v');
    assert.match(r.cleanUrl(detail, detail), /\/views\//);
    assert.equal(r.routeUrlState(detail).searchParams.get('viewId'), id);
  }
});
