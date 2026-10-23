// SPDX-License-Identifier: Apache-2.0
// Renders the real hosted route tree (Hosted.tsx → signed in → project selected) with test doubles for
// Convex and Clerk only, so wrappers and legacy containers around the cockpit pages are exercised.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToReadableStream } from 'react-dom/server';
import { createServer } from 'vite';
import { hostedTree, PROJECT } from './fixtures/hosted-tree/tree.mjs';

const web = fileURLToPath(new URL('../web', import.meta.url));
const fixture = name => fileURLToPath(new URL(`./fixtures/hosted-tree/${name}`, import.meta.url));

function browserGlobals(search) {
  const listeners = () => undefined;
  const store = () => {
    const map = new Map();
    return {
      getItem: k => map.get(k) ?? null,
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: k => map.delete(k),
    };
  };
  Object.assign(globalThis, {
    location: new URL(`https://forge.test/${search}`),
    history: { pushState() {}, replaceState() {} },
    addEventListener: listeners,
    removeEventListener: listeners,
    localStorage: store(),
    sessionStorage: store(),
    matchMedia: () => ({ matches: false, addEventListener: listeners, removeEventListener: listeners }),
  });
}

async function render(search, customize = () => {}) {
  process.env.VITE_CONVEX_URL = 'https://test.convex.cloud';
  process.env.VITE_CLERK_PUBLISHABLE_KEY = 'pk_test_tree';
  globalThis.__forgeTree = hostedTree();
  customize(globalThis.__forgeTree);
  browserGlobals(search);
  const server = await createServer({
    root: web,
    configFile: `${web}/vite.config.ts`,
    mode: 'hosted',
    logLevel: 'silent',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, watch: null },
    resolve: {
      alias: [
        { find: /^convex\/react$/, replacement: fixture('convex-react.mjs') },
        { find: /^convex\/react-clerk$/, replacement: fixture('convex-react-clerk.mjs') },
        { find: /^@clerk\/react$/, replacement: fixture('clerk-react.mjs') },
      ],
    },
    ssr: { noExternal: ['convex', '@clerk/react'] },
  });
  try {
    const { default: Hosted } = await server.ssrLoadModule('/src/Hosted.tsx');
    // Lazy routes suspend on their first import; inspect the complete page, not the fallback.
    const errors = [];
    const stream = await renderToReadableStream(h(Hosted), { onError: error => errors.push(error) });
    await stream.allReady;
    assert.deepEqual(errors, [], 'the hosted route renders without server errors');
    return await new Response(stream).text();
  } finally {
    await server.close();
  }
}

test('a selected hosted project renders only the cockpit shell and its page', async () => {
  const html = await render(`?surface=projects&collection=projects&project=${PROJECT}`);
  assert.match(html, /class="fx fx-app"/, 'the cockpit shell frames the page');
  assert.match(html, /fx-project-page/);
  assert.doesNotMatch(html, /class="fx-mode">hosted/);
  assert.match(html, /aria-label="Progress legend"/);
  assert.match(html, /class="fx-now2"/, 'Now renders inside the project page');
  assert.doesNotMatch(html, /aria-label="Source collections"/, 'no legacy collection tabs');
  assert.doesNotMatch(html, /project-workspace-heading/, 'no legacy project title');
  assert.match(html, /project-layout embedded/);
});

test('the project list unifies projects and source without collection tabs', async () => {
  const html = await render('?surface=projects&collection=projects&projectHome=list');
  assert.match(html, /fx-projects-home/);
  assert.match(html, /Filter projects/);
  assert.doesNotMatch(html, /aria-label="Source collections"/);
  assert.doesNotMatch(html, /fx-project-page/);
});

test('legacy styles sit in one cascade layer, so cockpit styles always win', () => {
  const read = name => readFileSync(new URL(`../web/src/${name}`, import.meta.url), 'utf8');
  for (const file of [
    'legacy.css',
    'legacy-hosted.css',
    'legacy-app.css',
    'legacy-account-data.css',
    'legacy-source-review.css',
  ])
    for (const line of read(file)
      .split('\n')
      .filter(item => item.startsWith('@import')))
      assert.match(line, /layer\(legacy\);$/, `${file}: ${line}`);
  const main = read('main.tsx');
  assert.doesNotMatch(main, /import '\.\/(style|experience|graph|work-clarity)\.css'/);
  // An embedded project page never keeps the legacy two-column grid with its tabs removed.
  assert.match(read('shell/hosted-frame.css'), /\.project-layout\.embedded\s*\{\s*display: block;/);
});

test('hosted Intents use one primary navigation and a compact page selector', async () => {
  const html = await render(`?surface=projects&project=${PROJECT}&projectTab=intent`);
  assert.doesNotMatch(html, /fx-subnav|Work concepts|the outcome you want/);
  assert.doesNotMatch(html, /<select[^>]*aria-label="Work pages"/);
  const workNav = html.match(/<nav[^>]*aria-label="Work pages"[\s\S]*?<\/nav>/)?.[0];
  assert.ok(workNav, 'the collection switcher is inside the Work heading');
  assert.match(workNav, /aria-label="Work views"/);
  assert.equal((workNav.match(/<button\b/g) ?? []).length, 3);
  assert.match(
    workNav,
    /<button[^>]*aria-pressed="true"[^>]*>(?:(?!<\/button>)[\s\S])*<span>Intents<\/span>/,
  );
  for (const label of ['Intents', 'Lanes', 'Planning'])
    assert.match(workNav, new RegExp(`<span>${label}</span>`));
  assert.doesNotMatch(workNav, /<span>Views<\/span>/);
  assert.match(html, /class="fx-mark"/);
  assert.match(html, /fill="#23cbff"/);
  assert.doesNotMatch(html, /nanthai-monogram/);
});

test('Settings defaults to General with controls and grouped navigation', async () => {
  const html = await render(`?surface=projects&project=${PROJECT}&projectTab=sharing`);
  assert.match(html, /fx-settings-layout/);
  assert.match(html, /<h1>General<\/h1>/);
  assert.match(html, /Visibility/);
  assert.doesNotMatch(html, /Host a folder/);
  assert.match(html, /Settings page/);
  for (const label of ['Checks', 'GitHub', 'Transfer &amp; backups', 'Signed-in devices', 'Profile'])
    assert.ok(html.includes(label), `Settings navigation retains ${label}`);
  assert.doesNotMatch(html, />Appearance</);
  assert.doesNotMatch(html, /managed by the owner/);
});
test('owner Access retains actual contributor controls without invented roles', async () => {
  const html = await render(`?surface=projects&project=${PROJECT}&projectTab=sharing&settingsSection=access`);
  assert.match(html, /<h1>Access<\/h1>/);
  assert.match(html, /Invite contributor/);
  assert.match(html, /@handle or email address/);
  assert.doesNotMatch(html, /managed by the owner|Reviewer|Maintainer/);
});

for (const section of ['autonomy', 'checks'])
  test(`reader ${section} shows values without edit controls`, async () => {
    const html = await render(
      `?surface=projects&project=${PROJECT}&projectTab=${section}&settingsSection=${section}`,
      tree => {
        const workspace = JSON.parse(tree.queries['projectWorkIndex:workspace']());
        workspace.capabilities.owner = false;
        tree.queries['projectWorkIndex:workspace'] = () => JSON.stringify(workspace);
      },
    );
    assert.match(html, /Only owners can change this/);
    assert.doesNotMatch(html, /Save autonomy|Autonomy preset|Define a check locally|role="switch"/);
  });

test('Home lists reader-only projects with a role tag', async () => {
  const html = await render('?surface=projects', tree => {
    tree.pages['projectBackups:list'] = () => [];
    tree.pages['projectContributors:shared'] = () => [];
    tree.pages['projectReaders:shared'] = () => [
      { id: PROJECT, name: 'Reader project with a very long title — release/production/2026' },
    ];
    tree.queries['projectCoordination:counts'] = () => ({
      activeAgents: 0,
      activeSubagents: 0,
      activePeople: 0,
    });
  });
  assert.match(html, /Reader project with a very long title/);
  assert.match(html, /class="fx-home-tag">Reader/);
  assert.doesNotMatch(html, /No projects yet/);
  assert.doesNotMatch(html, /portal-footer/);
});

test('reader General presents facts once in its table without the owner summary', async () => {
  const html = await render(
    `?surface=projects&project=${PROJECT}&projectTab=settings&settingsSection=general`,
    tree => {
      const workspace = JSON.parse(tree.queries['projectWorkIndex:workspace']());
      workspace.capabilities.owner = false;
      tree.queries['projectWorkIndex:workspace'] = () => JSON.stringify(workspace);
    },
  );
  assert.match(html, /<b>Visibility<\/b><span>Private<\/span>/);
  assert.doesNotMatch(html, /fx-settings-summary/);
});

test('Checks renders all recent definitions with one Older disclosure and no more controls', async () => {
  const checks = Array.from({ length: 34 }, (_, index) => ({
    id: `recent-${index}`,
    name: `Recent check ${index}`,
  }));
  const old = Array.from({ length: 64 }, (_, index) => ({
    id: `old-${index}`,
    name: `Older check ${index}`,
  }));
  const now = new Date().toISOString();
  const html = await render(
    `?surface=projects&project=${PROJECT}&projectTab=checks&settingsSection=checks`,
    tree => {
      tree.pages['projectWorkIndex:records'] = args => {
        const values =
          args.collection === 'checks'
            ? [...checks, ...old]
            : args.collection === 'runs'
              ? checks.map(check => ({
                  id: `run-${check.id}`,
                  checkId: check.id,
                  startedAt: now,
                  status: 'passed',
                }))
              : [];
        return values.map((value, position) => ({ id: value.id, position, value: JSON.stringify(value) }));
      };
    },
  );
  assert.equal((html.match(/class="fx-check-table-row"/g) || []).length, 34);
  assert.match(html.replace(/<!--.*?-->/g, ''), /Older checks \(64\)/);
  assert.doesNotMatch(html, />\d+ more</);
});

test('hosted Profile renders the handle control with a protocol-free preview and quiet current state', async () => {
  const html = await render(`?surface=projects&project=${PROJECT}&projectTab=you&settingsSection=you`);
  assert.match(html, /<h1>You<\/h1>/);
  assert.match(html, /value="test-viewer"/);
  assert.match(html, /forge.test<!-- -->\/<!-- -->test-viewer/);
  assert.doesNotMatch(html, /Your current handle|Links using your previous handle|id="handle-validation"/);
});

test('hosted frame shares summary and coordination pages across strip and Now', async () => {
  const calls = new Map();
  await render(`?surface=projects&project=${PROJECT}&projectTab=overview`, tree => {
    for (const name of [
      'projectWorkIndex:records',
      'projectCoordination:sessions',
      'projectCoordination:recent',
    ]) {
      const original = tree.pages[name];
      tree.pages[name] = args => {
        const key = name === 'projectWorkIndex:records' ? `${name}:${args.collection}` : name;
        calls.set(key, (calls.get(key) ?? 0) + 1);
        return original?.(args) ?? [];
      };
    }
  });
  for (const collection of ['intents', 'lanes', 'views', 'runs'])
    assert.equal(calls.get(`projectWorkIndex:records:${collection}`), 1, collection);
  assert.equal(calls.get('projectCoordination:sessions'), 1);
  assert.equal(calls.get('projectCoordination:recent'), 1);
});

for (const [label, counts] of [
  ['unavailable workspace', null],
  ['legacy workspace without counts', undefined],
  ['legacy workspace without landing collections', {}],
  ['landing entries without batches', { landingEntries: 0 }],
  ['landing collections', { landingEntries: 0, landingBatches: 0 }],
])
  test(`hosted shell renders with ${label} and subscribes only to available landing collections`, async () => {
    const calls = new Map();
    const html = await render(`?surface=projects&project=${PROJECT}&projectTab=overview`, tree => {
      const workspace = tree.queries['projectWorkIndex:workspace'];
      tree.queries['projectWorkIndex:workspace'] = () =>
        counts === null ? null : JSON.stringify({ ...JSON.parse(workspace()), counts });
      const records = tree.pages['projectWorkIndex:records'];
      tree.pages['projectWorkIndex:records'] = args => {
        calls.set(args.collection, (calls.get(args.collection) ?? 0) + 1);
        return records(args);
      };
    });
    assert.match(html, /class="fx fx-app"/);
    if (counts === null) assert.match(html, /role="status">Loading project Work…/);
    else assert.match(html, /class="fx-now2"/);
    for (const collection of ['landingEntries', 'landingBatches'])
      assert.equal(calls.get(collection) ?? 0, counts?.[collection] === undefined ? 0 : 1, collection);
    if (counts !== null) assert.match(html, /Check failed/, 'legacy check evidence still renders');
    assert.doesNotMatch(html, /owner not seen|queue · /, 'missing worker data adds no strip placeholder');
  });

test('account settings retain the existing Clerk account management entry', async () => {
  const html = await render('?surface=account&settings=account');
  assert.match(html, /Manage account/);
});

test('behind hosted shell shows one sync line, never Live, with static generation statuses', async () => {
  const html = await render(`?surface=projects&collection=projects&project=${PROJECT}`, tree => {
    const workspace = JSON.parse(tree.queries['projectWorkIndex:workspace']());
    workspace.freshness = {
      syncedAt: Date.now() - 3 * 3600000,
      sourceRevision: 1,
      mainHead: 'old',
      machine: { name: 'Mac Studio', reportedAt: Date.now(), mainHead: 'new' },
      ownerReport: { revision: 2, reportedAt: Date.now() },
      push: { startedAt: Date.now(), pending: 'Publishing source and Work' },
    };
    tree.queries['projectWorkIndex:workspace'] = () => JSON.stringify(workspace);
    const page = tree.pages['projectWorkIndex:records'];
    tree.pages['projectWorkIndex:records'] = args =>
      page(args).map(row =>
        args.collection === 'runs'
          ? {
              ...row,
              value: JSON.stringify({
                ...JSON.parse(row.value),
                status: 'running',
                startedAt: new Date().toISOString(),
                endedAt: undefined,
              }),
            }
          : row,
      );
  });
  const text = html.replace(/<!--.*?-->/gs, '');
  assert.equal((text.match(/Synced from Mac Studio/g) ?? []).length, 1);
  assert.match(text, /3 h ago.*catching up/);
  assert.match(html, /Last hosted sync/);
  assert.match(html, /Last owner-machine report/);
  assert.doesNotMatch(html, /class="fx-pulse"|>Live</);
  assert.match(html, /fx-tone-stale/);
  assert.match(html, /as of/);
});
