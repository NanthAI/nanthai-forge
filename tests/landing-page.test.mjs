// SPDX-License-Identifier: Apache-2.0
// The public page (web/index.html) is static: its figures, links and copied prompt are checked here against the
// published evidence and the repository, so a wording or number change cannot drift from its source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const html = read('web/index.html');
const css = read('web/src/landing/landing.css');
const tokens = read('web/src/ds/tokens.css');
const scripts = ['page.ts', 'frames.ts', 'hero.ts'].map(name => [name, read(`web/src/landing/${name}`)]);
const text = html
  .replace(/<script>[\s\S]*?<\/script>/g, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .replace(/ ([.,;:])/g, '$1');
const pct = (forge, github) => `${Math.round((1 - forge / github) * 100)}%`;
const minSec = s => `${Math.floor(Math.round(s) / 60)} min ${Math.round(s) % 60} s`;
const mmss = s => `${Math.floor(Math.round(s) / 60)}:${String(Math.round(s) % 60).padStart(2, '0')}`;

// The headline table of the P6 exit report: N, arm, source, cells, TTM, TTM excl. flags, wall, CI min, cached input, …
const bench = Object.fromEntries(
  [
    ...read('docs/research/p6-exit-bench-results.md').matchAll(
      /^\| (\d+) \| (forge|github) \| (?:tuned|rerun) \| 3 \| ([\d.]+) \| [\d.]+ \| ([\d.]+) \| (\d+) \| (\d+) \| \d+ \| (\d+) \|$/gm,
    ),
  ].map(([, n, arm, ttm, wall, ci, cached, recovery]) => [
    `${arm}${n}`,
    { ttm: +ttm, wall: +wall, ci: +ci, cached: +cached, recovery: +recovery },
  ]),
);
const release = read('docs/research/p6-release-validation.md');

test('every headline figure is derived from the published P6 exit report', () => {
  assert.equal(Object.keys(bench).length, 8, 'the report headline table has both arms at N=1, 3, 5 and 10');
  const f = bench.forge10,
    g = bench.github10;
  assert.match(text, new RegExp(`main ${pct(f.ttm, g.ttm)} sooner, on ${pct(f.ci, g.ci)} fewer CI minutes`));
  assert.match(
    html,
    new RegExp(
      `<meta name="description" content="[^"]*${pct(f.ttm, g.ttm)} sooner on ${pct(f.ci, g.ci)} fewer CI minutes`,
    ),
  );
  assert.match(text, new RegExp(`in ${minSec(f.ttm)} instead of ${minSec(g.ttm)}`));
  assert.match(text, new RegExp(`billed ${f.ci} CI minutes on Forge and ${g.ci} through the GitHub flow`));
  assert.match(
    text,
    new RegExp(
      `read ${(f.cached / 1e6).toFixed(1)} million cached input tokens instead of ${(g.cached / 1e6).toFixed(1)} million`,
    ),
  );
  const earlier = g.wall - f.wall;
  assert.match(text, new RegExp(`Forge finished ${minSec(earlier)} earlier`));
  // The race replays the same four times, to scale.
  for (const at of [f.ttm, f.wall, g.ttm, g.wall]) assert.ok(html.includes(`data-at="${at}"`), String(at));
  for (const [s, x] of [
    [f.ttm, ((f.ttm / g.wall) * 100).toFixed(2)],
    [f.wall, ((f.wall / g.wall) * 100).toFixed(2)],
    [g.ttm, ((g.ttm / g.wall) * 100).toFixed(2)],
  ])
    assert.ok(html.includes(`--x:${x}%" data-at="${s}"`), `${s} sits at ${x}%`);
  for (const s of [f.ttm, f.wall, g.ttm, g.wall]) assert.ok(html.includes(`<b>${mmss(s)}</b>`), mmss(s));
  assert.ok(
    css.includes(`clip-path: inset(0 ${(100 - (f.wall / g.wall) * 100).toFixed(2)}% 0 0)`),
    'the Forge run ends at its wall time',
  );
  // Bars: the four ten-agent comparisons and their reductions.
  for (const [forge, github] of [
    [f.ci, g.ci],
    [f.cached, g.cached],
    [f.ttm, g.ttm],
    [f.wall, g.wall],
  ])
    assert.match(
      html,
      new RegExp(
        `--v:${+((forge / github) * 100).toFixed(1)}%[\\s\\S]{0,400}?<div class="pct">${pct(forge, github)}<`,
      ),
    );
});

test('the per-size charts and table match the report at 1, 3, 5 and 10 agents', () => {
  const rows = [
    ...html.matchAll(
      /<tr><td>(\d+)<\/td><td>(\d+)<\/td><td>(\d+)<\/td><td>(\d+) s<\/td><td>(\d+) s<\/td><td>([\d.]+) M<\/td><td>([\d.]+) M<\/td><\/tr>/g,
    ),
  ];
  assert.deepEqual(
    rows.map(r => r[1]),
    ['1', '3', '5', '10'],
  );
  for (const [, n, ciF, ciG, tF, tG, cF, cG] of rows) {
    const f = bench[`forge${n}`],
      g = bench[`github${n}`];
    assert.deepEqual(
      [+ciF, +ciG, +tF, +tG, cF, cG],
      [
        f.ci,
        g.ci,
        Math.round(f.ttm),
        Math.round(g.ttm),
        (f.cached / 1e6).toFixed(1),
        (g.cached / 1e6).toFixed(1),
      ],
      `N=${n}`,
    );
    const agents = n === '1' ? '1 agent' : `${n} agents`;
    assert.ok(html.includes(`${agents}: ${f.ci} min against ${g.ci}<`), `CI tip N=${n}`);
    assert.ok(
      html.includes(`${agents}: ${Math.round(f.ttm)} s against ${Math.round(g.ttm)} s<`),
      `TTM tip N=${n}`,
    );
    assert.ok(
      html.includes(`${agents}: ${(f.cached / 1e6).toFixed(1)} M against ${(g.cached / 1e6).toFixed(1)} M<`),
      `cached tip N=${n}`,
    );
    for (const [forge, github] of [
      [f.ci, g.ci],
      [f.ttm, g.ttm],
      [f.cached, g.cached],
    ])
      assert.match(
        html,
        new RegExp(`<span class="d">${pct(forge, github)}( lower)?</span><span class="tip">${agents}:`),
        `${agents} ${pct(forge, github)}`,
      );
  }
});

test('the limits section states the caveats the reports carry', () => {
  assert.match(
    text,
    new RegExp(`its agents took ${bench.forge10.recovery} recovery turns against ${bench.github10.recovery}`),
  );
  assert.match(release, /\| Time to main\/task, median s \| 375\.362 \| 474\.429 \|/);
  assert.match(release, /\| CI jobs \| 9 \| 29 \|/);
  assert.match(release, /\| Strict correctness, of ten \| 6 \| 7 \|/);
  assert.match(text, /375 s against 474 s to main, and 6 of ten tasks strictly right against 7/);
  assert.match(text, /9 CI jobs against 29 on the release run/);
  assert.match(text, /not a pass of the exit bar/);
  assert.match(html, /docs\/research\/p6-exit-bench-results\/">Method, raw runs and every table/);
});

test('every link on the page has a real destination', () => {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
  const hrefs = [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map(m => m[1]);
  assert.ok(hrefs.length >= 15);
  for (const href of hrefs) {
    if (href.startsWith('#')) assert.ok(ids.has(href.slice(1)), `${href} names a section on the page`);
    else if (href.startsWith('https://github.com/NanthAI/nanthai-forge/blob/main/'))
      assert.ok(
        existsSync(
          new URL(
            `../${href.slice('https://github.com/NanthAI/nanthai-forge/blob/main/'.length)}`,
            import.meta.url,
          ),
        ),
        href,
      );
    else if (href.startsWith('https://'))
      assert.equal(href, 'https://github.com/NanthAI/nanthai-forge', href);
    else
      assert.ok(
        ['/', '/projects', '/llms.txt', '/-/privacy', '/-/terms'].includes(href) ||
          /^\/docs\/(?:[a-z0-9/-]+\/)?$/.test(href),
        `${href} is a page the site serves`,
      );
  }
  for (const [label, href] of [
    ['Docs', '/docs/'],
    ['Benchmark method', '/docs/research/p6-exit-bench-results/'],
    ['Development status', '/docs/status/'],
    ['Security', '/docs/security/'],
    ['Source', 'https://github.com/NanthAI/nanthai-forge'],
    ['Privacy', '/-/privacy'],
    ['Terms', '/-/terms'],
  ])
    assert.ok(html.includes(`<a href="${href}">${label}</a>`), label);
  assert.match(html, /<a class="in" href="\/projects">Sign in<\/a>/);
  assert.match(
    text,
    /in open development and builds itself\. There is no public service or package yet, and nothing is charged\. Development status/,
  );
});

test('the pricing section shows the billing contract plans and says nothing is charged yet', async () => {
  const { plans, extraBlock } = await import('../web/src/billing/contract.ts');
  const shown = [...html.matchAll(/<div class="plan">([\s\S]*?)<\/div>\n/g)].map(m => m[1]);
  assert.equal(shown.length, Object.keys(plans).length, 'one column per plan');
  const most = Math.max(...Object.values(plans).map(p => p.includedLandings));
  for (const [i, plan] of Object.values(plans).entries()) {
    const col = shown[i];
    assert.match(col, new RegExp(`<h3 class="pn">${plan.name}</h3>`));
    assert.ok(col.includes(`<span class="amt">$${plan.monthlyUsd}</span>`), `${plan.name} price`);
    assert.ok(
      col.includes(`<span class="per">${plan.monthlyUsd ? 'a month' : 'free'}</span>`),
      `${plan.name} period`,
    );
    assert.ok(
      col.includes(`<b>${plan.includedLandings.toLocaleString('en-US')}</b> landings a month`),
      plan.name,
    );
    assert.ok(
      col.includes(`--v:${+((plan.includedLandings / most) * 100).toFixed(1)}%`),
      `${plan.name} meter to scale`,
    );
  }
  // Paid plans cannot be started yet: only the free plan has an action, and it is the app's first run.
  assert.equal((html.match(/class="btn/g) ?? []).length, 1);
  assert.ok(shown[0].includes('<a class="btn go" href="/projects">Import a repository</a>'));
  assert.ok(
    text.includes(`Extra landings $${extraBlock.usd} per ${extraBlock.landings}, only when you go over`),
  );
  assert.match(text, /Prices planned for launch\. Nothing is charged before then\./);
  assert.doesNotMatch(
    html,
    /[Yy]early|annual/,
    'yearly billing is out of the first build (owner decision 4.10)',
  );
  assert.match(html, /<a class="wide" href="#pricing">Pricing<\/a>/);
});

test('"Give this to your agent" copies an explain-first prompt that routes through llms.txt', () => {
  assert.equal((html.match(/data-copy>/g) ?? []).length, 2, 'two keys, one prompt');
  const prompt = /<pre id="prompt" data-prompt>([\s\S]*?)<\/pre>/.exec(html)?.[1] ?? '';
  assert.match(prompt, /^Read \/llms\.txt on the site this prompt came from\.\n\n/);
  assert.match(prompt, /tell me, in five lines/);
  assert.match(prompt, /Do not install anything yet\.$/);
  assert.match(text, /tells you what would change in your repository before it sets anything up/);
  assert.match(text, /It explains first and installs nothing/);
  const page = scripts[0][1];
  assert.ok(
    page.includes('/^Read \\/llms\\.txt on the site this prompt came from\\./'),
    'page.ts rewrites the first line',
  );
  assert.ok(page.includes('${location.origin}/llms.txt'), 'to this site');
  assert.match(page, /peek\.open = true/, 'a failed copy opens the prompt instead');
});

test('the page loads no app code, no network and no stored state from its scripts', () => {
  for (const [name, source] of scripts) {
    for (const [, from] of source.matchAll(/(?:from |import\()\s*'([^']+)'/g))
      assert.ok(['./frames', './hero'].includes(from), `${name} imports ${from}`);
    assert.doesNotMatch(
      source,
      /\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|localStorage|sessionStorage|indexedDB|convex/i,
      name,
    );
    assert.doesNotMatch(source, /setInterval/, `${name}: no idle timers`);
  }
  // Illustrations use Lane titles, never people's handles.
  assert.doesNotMatch(html + scripts.map(s => s[1]).join(''), /\b(?:mara|jun|bartholomew)\//);
});

test('the hero runs one loop that pauses off screen, in a hidden tab and under reduced motion, and calms at 60 s', () => {
  const hero = scripts[2][1],
    page = scripts[0][1],
    frames = scripts[1][1];
  assert.equal((frames.match(/requestAnimationFrame\(/g) ?? []).length, 2, 'frames.ts owns the one loop');
  for (const [name, source] of [
    ['page.ts', page],
    ['hero.ts', hero],
  ])
    assert.doesNotMatch(source, /requestAnimationFrame/, name);
  assert.match(
    hero,
    /const want = \(\) => !document\.hidden && !RM\.matches && sigs\.some\(s => s\.inView\)/,
  );
  assert.match(hero, /now - lastInput > 60_000 \? 'slow' : 'awake'/);
  assert.match(hero, /stats\.calm === 'slow' \? 63 : 30/);
  assert.match(hero, /if \(RM\.matches\) s\.still\(\)/);
  assert.match(page, /import\('\.\/hero'\)/, 'the hero module loads lazily');
  assert.match(page, /requestIdleCallback/);
});

test('the page works without JavaScript: hidden-until-animated states apply only under .js', () => {
  assert.match(html, /<span class="num" data-clock>19:42<\/span>/);
  assert.equal((html.match(/class="mk(?: last)? on"/g) ?? []).length, 4);
  for (const rule of css
    .split('\n')
    .filter(line => /scale[XY]\(0\)|\.term div \{ opacity: 0|\.band \.wd \{ opacity/.test(line)))
    assert.match(rule, /^\.js /, rule);
  assert.match(html, /d\.className='js'/);
});

test('head, tokens, fonts and size budget', () => {
  for (const tag of ['og:title', 'og:description', 'og:type', 'og:site_name'])
    assert.match(html, new RegExp(`<meta property="${tag}" content="[^"]+">`));
  assert.match(html, /<meta name="twitter:card" content="summary">/);
  // One token source for the public page and the app (Item 6ebb58ab): the page imports it and sets data-ds.
  assert.match(css, /^@import "\.\.\/ds\/tokens\.css";$/m);
  assert.match(html, /^<html lang="en" data-ds>$/m);
  assert.doesNotMatch(css, /^\s*--[a-z0-9-]+:/m, 'the page sheet declares no tokens of its own');
  for (const token of [
    '--font-sans',
    '--font-mono',
    '--series',
    '--brand-edge',
    '--r-key',
    '--wrap-land',
    '--calm-after',
    '--t-land',
  ])
    assert.ok(tokens.includes(`${token}:`), token);
  assert.match(tokens, /--font-sans: "Atkinson Hyperlegible Next"/);
  assert.match(tokens, /--font-mono: "Atkinson Hyperlegible Mono"/);
  assert.match(read('web/src/assets/NOTICE.md'), /## Atkinson Hyperlegible Next and Mono/);
  assert.match(read('web/public/assets/AtkinsonHyperlegible-OFL.txt'), /SIL OPEN FONT LICENSE Version 1\.1/);
  const gz = source => gzipSync(source).length;
  assert.ok(gz(html) < 9_000, `index.html ${gz(html)} B gzip`);
  assert.ok(gz(css) < 8_000, `landing.css ${gz(css)} B gzip`);
  assert.ok(gz(tokens) < 3_100, `ds/tokens.css ${gz(tokens)} B gzip`);
  // Source with comments; the built page script is about 2 KB gzip and the lazy hero about 5 KB (docs/development.md).
  assert.ok(gz(scripts.map(s => s[1]).join('\n')) < 12_000, 'landing scripts stay a few KB');
});
