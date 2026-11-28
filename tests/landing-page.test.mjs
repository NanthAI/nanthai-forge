// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The public page (web/index.html) is static: its figures, links and copied prompt are checked here against the
// published evidence and the repository, so a wording or number change cannot drift from its source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { gzipSync } from 'node:zlib';
import ts from 'typescript';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const html = read('web/index.html');
const css = read('web/src/landing/landing.css');
const tokens = read('web/src/ds/tokens.css');
const scripts = ['page.ts', 'frames.ts', 'hero.ts'].map(name => [name, read(`web/src/landing/${name}`)]);
const copyMarkup = html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
const text = copyMarkup
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .replace(/ ([.,;:])/g, '$1');
const mmss = s => `${Math.floor(Math.round(s) / 60)}:${String(Math.round(s) % 60).padStart(2, '0')}`;
const saving = (forge, github) => ((github - forge) / github) * 100;
const pct = value => `${Math.round(value)}%`;
const share = value => `${(100 - value).toFixed(2)}%`;
const median = sorted => {
  const middle = (sorted.length - 1) / 2;
  return (sorted[Math.floor(middle)] + sorted[Math.ceil(middle)]) / 2;
};
const close = read('docs/research/p7-close-bench-results.md');
const arms = new Map(
  [
    ...close.matchAll(
      /^\| (forge|github)-n10-r1-(a\d+)-\d+T\d+ \| .*? \| .*? \| .*? \| 10 \| ([\d.]+) \| ([\d.]+) \| (\d+) \| ([\d.]+) \| .*? \| Valid scored \|/gm,
    ),
  ].map(([, arm, attempt, ...metrics]) => [`${arm}/${attempt}`, metrics.map(Number)]),
);
const pool = ['a7', 'a9', 'a10', 'a11', 'a12', 'a13'];
const exclusions = [['a13'], [], ['a10'], ['a10']];
const pooled = poolMetric =>
  pool
    .filter(attempt => !exclusions[poolMetric].includes(attempt))
    .map(attempt =>
      saving(arms.get(`forge/${attempt}`)[poolMetric], arms.get(`github/${attempt}`)[poolMetric]),
    )
    .sort((a, b) => a - b);

const descriptionNames = ['description', 'og:description', 'twitter:description'];
const descriptions = [...copyMarkup.matchAll(/<meta\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi)].flatMap(
  ([, tag]) => {
    const attributes = new Map(
      [...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+))/g)].map(
        ([, name, doubleQuoted, singleQuoted, unquoted]) => [
          name.toLowerCase(),
          doubleQuoted ?? singleQuoted ?? unquoted,
        ],
      ),
    );
    const isDescription = ['name', 'property'].some(key =>
      descriptionNames.includes(attributes.get(key)?.toLowerCase()),
    );
    return isDescription ? [attributes.get('content') ?? ''] : [];
  },
);
const publicCopy = [
  text,
  ...descriptions,
  ...[...copyMarkup.matchAll(/\b(?:alt|title|aria-label)="([^"]*)"/gi)].map(([, label]) => label),
].map(copy => copy.replace(/&nbsp;|&#0*160;|&#x0*a0;/gi, ' '));

test('public homepage copy uses plain terms for measured results', () => {
  const jargon = /\b(?:phase\s*\d+|p[67]|n\s*=\s*\d+|arms?)\b/gi;
  assert.deepEqual(
    publicCopy.flatMap(copy => copy.match(jargon) ?? []),
    [],
  );
});

test('homepage text and descriptions leave calendar dates to the linked results', () => {
  const month =
    'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
  const day = '\\d{1,2}(?:st|nd|rd|th)?';
  const dates = new RegExp(
    `\\b(?:(?:19|20)\\d{2}|${day}[ .\\/-]+(?:${month})|(?:${month})[ .\\/-]+${day}|\\d{1,2}\\/\\d{1,2})\\b`,
    'gi',
  );
  assert.deepEqual(
    publicCopy.flatMap(copy => copy.match(dates) ?? []),
    [],
  );
});

test('headline and top bars agree with eligible paired ten-agent results', () => {
  assert.match(close, /The a13 .* excludes that pair from wall time only\./);
  assert.match(close, /The a10 .* excludes that pair from CI and cached input only\./);
  const names = ['Wall time', 'Median task time', 'CI minutes', 'Cached input tokens'];
  const rows = html.split('\n');
  const medians = names.map((name, metric) => {
    const values = pooled(metric);
    const best = values.at(-1);
    const forgeShare = 100 - Math.round(best);
    const row = rows.find(line => line.includes(`<div class="nm">${name}<`));
    assert.ok(row, `${name} has a results row`);
    assert.ok(row.includes(`<i class="f" style="--v:${forgeShare}%"></i><span>${forgeShare}%</span>`), name);
    assert.ok(
      row.includes(
        `<small>up to</small>${pct(best)}<span class="sr"> lower</span><small>median ${pct(median(values))}</small>`,
      ),
      name,
    );
    return pct(median(values));
  });
  const headline = `Ten agents reached main ${medians[0]} sooner, on ${medians[2]} fewer CI minutes.`;
  assert.ok(text.includes(headline));
  assert.ok(descriptions[0].includes(headline));
  assert.match(
    html,
    /Paired runs of ten tasks\. <a class="lk" href="\/docs\/research\/p7-close-bench-results\/">Full results/,
  );
});

test('the replay uses the eligible pair closest to the headline wall and CI medians', () => {
  const metrics = [0, 2];
  const distance = attempt =>
    Math.hypot(
      ...metrics.map(
        metric =>
          saving(arms.get(`forge/${attempt}`)[metric], arms.get(`github/${attempt}`)[metric]) -
          median(pooled(metric)),
      ),
    );
  const attempt = pool
    .filter(attempt => metrics.every(metric => !exclusions[metric].includes(attempt)))
    .sort((a, b) => distance(a) - distance(b))[0];
  const [fAll, fMedian] = arms.get(`forge/${attempt}`);
  const [gAll, gMedian] = arms.get(`github/${attempt}`);
  const replay = html.split('<section class="sec" id="speed"')[1].split('</section>')[0];
  assert.ok(replay.includes('The headline summarizes all eligible pairs.'));
  for (const at of [fMedian, fAll, gMedian, gAll]) {
    const x = at === gAll ? '100' : ((at / gAll) * 100).toFixed(2);
    assert.ok(
      replay.match(new RegExp(`--x:${x}%\" data-at=\"${at.toFixed(3)}\"`, 'g'))?.length === 2,
      `${at} sits at ${x}% in marker and label`,
    );
    assert.ok(replay.includes(`<b>${mmss(at)}</b>`));
  }
  assert.ok(replay.includes(`clip-path:inset(0 ${saving(fAll, gAll).toFixed(2)}% 0 0)`));
  assert.ok(replay.includes(`data-clock>${mmss(gAll)}</span>`));
  const gap = Math.round(gAll - fAll);
  assert.ok(replay.includes(`Forge finished ${Math.floor(gap / 60)} min ${gap % 60} s earlier.`));
});

test('animated replay takes its clock, progress and captions from the markup timings', () => {
  const page = scripts[0][1];
  const replay = page.slice(page.indexOf('const race ='), page.indexOf('/* The hero signature'));
  const { outputText } = ts.transpileModule(replay, { compilerOptions: { target: ts.ScriptTarget.ESNext } });
  const marks = [60, 180, 132, 240].map(at => ({
    dataset: { at: String(at) },
    matches: selector => selector === '.mk',
    classList: { toggle() {} },
  }));
  const readout = {
    innerHTML: 'Final readout',
    append(_space, span) {
      this.textContent += ' ' + span.textContent;
    },
  };
  const forgeRun = { style: {} };
  const clock = {};
  const nodes = {
    '[data-race]': {},
    '[data-clock]': clock,
    '[data-readout]': readout,
    '[data-run="f"]': forgeRun,
  };
  let step;
  runInNewContext(outputText, {
    $: selector => nodes[selector],
    $$: () => marks,
    RM: { matches: false },
    doc: { addEventListener() {}, createElement: () => ({}) },
    awake: () => true,
    stats: {},
    performance: { now: () => 0 },
    onLive: (_node, callback) => callback(true),
    runFrames: frame => {
      step = frame;
    },
  });
  let now = 0;
  const advance = frames => {
    for (let i = 0; i < frames; i++) step((now += 50));
  };
  advance(10);
  assert.equal(clock.textContent, '1:00');
  assert.match(readout.textContent, /median is 1 min 12 s after Forge’s/);
  advance(12);
  assert.match(readout.textContent, /on main, 1 min 12 s after Forge’s/);
  advance(18);
  assert.equal(clock.textContent, '4:00');
  assert.equal(forgeRun.style.clipPath, 'inset(0 25.00% 0 0)');
});

test('per-size marks, tooltips and table report the same min, median and max paired savings', () => {
  const older = JSON.parse(read('docs/research/p6-exit-bench-results.json')).series.find(
    s => s.name === 'tuned',
  );
  const sizes = [1, 3, 5, 10];
  const metrics = [
    ['CI minutes', 'ciBilledMinutes', 2],
    ['Median task time', 'observedTimeToMainMedianSeconds', 1],
    ['Cached input tokens', 'cachedInputTokens', 3],
  ];
  const chartMarkup = [...html.matchAll(/<div class="chart"><h4>([^<]+)<\/h4>([\s\S]+?)<div class="xs">/g)];
  assert.deepEqual(
    chartMarkup.map(([, name]) => name),
    metrics.map(([name]) => name),
  );
  const tableMarkup = html.split('<table data-figures>')[1].split('</table>')[0];
  for (const size of sizes) {
    const cells = older.cells.filter(c => c.kind === 'scored' && c.N === size);
    const row = metrics.map(([name, key, metric], index) => {
      const values =
        size === 10
          ? pooled(metric)
          : [1, 2, 3]
              .map(rep => {
                const get = arm => cells.find(c => c.arm === arm && c.rep === rep).perCell[key];
                return saving(get('forge'), get('github'));
              })
              .sort((a, b) => a - b);
      const low = values[0],
        middle = median(values),
        high = values.at(-1);
      const groups = chartMarkup[index][2].split('<div class="grp"').slice(1);
      assert.equal(groups.length, sizes.length);
      const group = groups[sizes.indexOf(size)];
      const id = `${size} agents, ${name}`;
      assert.ok(group.includes(`--best:${share(high)};--median:${share(middle)};--worst:${share(low)}`), id);
      assert.ok(
        group.includes(
          `<small>up to</small>${pct(high)}<span class="sr"> lower</span><small>median ${pct(middle)}</small>`,
        ),
        id,
      );
      assert.ok(
        group.includes(
          `${size} ${size === 1 ? 'agent' : 'agents'} · Forge savings<br>Min ${pct(low)} · Median ${pct(middle)} · Max ${pct(high)}`,
        ),
        id,
      );
      return `<td>${[low, middle, high].map(pct).join(' / ')}</td>`;
    });
    assert.ok(tableMarkup.includes(`<tr><th scope="row">${size}</th>${row.join('')}</tr>`));
  }
});

test('the limits section names the workload, CI gate miss and separate overlap run', () => {
  assert.match(text, /six pairs of runs on one workload/);
  assert.match(text, /29 CI minutes\. The target for those runs was 27 minutes/);
  assert.doesNotMatch(text, /9 CI jobs against 29 on the release run/);
  assert.match(text, /separate run where eight tasks edit the same files/);
  assert.match(html, /docs\/research\/p7-close-bench-results\/">Method, raw runs and every table/);
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
        ['/', '/signin', '/new/import', '/llms.txt', '/privacy', '/terms', '/_forge/build.json'].includes(
          href,
        ) || /^\/docs\/(?:[a-z0-9/-]+\/)?$/.test(href),
        `${href} is a page the site serves`,
      );
  }
  for (const [label, href] of [
    ['Docs', '/docs/'],
    ['Benchmark method', '/docs/research/p7-close-bench-results/'],
    ['Development status', '/docs/status/'],
    ['Security', '/docs/security/'],
    ['Source', 'https://github.com/NanthAI/nanthai-forge'],
    ['Privacy', '/privacy'],
    ['Terms', '/terms'],
  ])
    assert.ok(html.includes(`<a href="${href}">${label}</a>`), label);
  assert.match(html, /<a class="in" href="\/signin">Sign in<\/a>/);
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
  assert.ok(shown[0].includes('<a class="btn go" href="/new/import">Import a repository</a>'));
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
  assert.match(html, /<span class="num" data-clock>\d+:\d{2}<\/span>/);
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
