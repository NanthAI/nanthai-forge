// SPDX-License-Identifier: Apache-2.0
// The Flow picture on Needs me (Item 85f456c1, Lane 2) in a real browser, on the Needs me fixture
// (tests/browser/needs-me.tsx) through the real shell frame: every stop's count is the top bar's count and its blocks
// (one source, the line feed); the approved home layout (picture left, Needs you right, FYI and Loose ends below, the
// picture gives Needs you width while it holds anything, a phone reads Needs you first); widths 861 to 1440 have no
// sideways scroll and the right size step; a held block's tag goes to its row under Needs you; worst-case text (long
// handles, right-to-left and 50+ character titles) and a request asked ahead stay inside their boxes, axe clean in
// both themes; nothing sets a repeating timer. Set FORGE_NEEDS_SHOTS to a folder to also save the screenshots.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const shots = process.env.FORGE_NEEDS_SHOTS || null;
const FIXTURE = 'tests/browser/needs-me.tsx';
const STOPS = ['editing', 'saved', 'queued', 'checking'];
/** The picture's size step for its width (web/src/app/flow/geometry.ts `tierOf`). */
const tierOf = width => (width >= 1000 ? 2 : width >= 640 ? 1 : 0);

async function buildFixture(out) {
  const { build } = await import(pathToFileURL(join(root, 'node_modules/vite/dist/node/index.js')).href);
  const result = await build({
    configFile: join(root, 'web/vite.config.ts'),
    root: join(root, 'web'),
    mode: 'hosted',
    logLevel: 'error',
    build: { outDir: out, emptyOutDir: true, rolldownOptions: { input: { fixture: join(root, FIXTURE) } } },
  });
  const output = (Array.isArray(result) ? result[0] : result).output;
  const entry = output.find(item => item.isEntry && item.facadeModuleId?.endsWith(FIXTURE));
  const chunks = new Map(output.map(item => [item.fileName, item]));
  const css = new Set();
  const seen = new Set();
  const walk = name => {
    if (seen.has(name)) return;
    seen.add(name);
    const chunk = chunks.get(name);
    for (const file of chunk?.viteMetadata?.importedCss ?? []) css.add(file);
    for (const next of [...(chunk?.imports ?? []), ...(chunk?.dynamicImports ?? [])]) walk(next);
  };
  walk(entry.fileName);
  return `<!doctype html><html lang="en" data-ds data-theme="dark"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>Needs me fixture</title>${[...css].map(file => `<link rel="stylesheet" href="/${file}">`).join('')}</head><body><div id="root"></div><script type="module" src="/${entry.fileName}"></script></body></html>`;
}

test('Needs me Flow picture: one source, the home layout, widths, tags and worst-case text', async t => {
  if (!existsSync(chromium.executablePath())) return t.skip('Playwright Chromium is not installed.');
  const out = mkdtempSync(join(tmpdir(), 'forge-needs-flow-'));
  if (shots) mkdirSync(shots, { recursive: true });
  const html = await buildFixture(out);
  const browser = await chromium.launch();
  async function open(t, width, data, { theme = 'dark', layout = null } = {}) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    await context.addInitScript(
      dock => {
        // Any interval, or a timeout of a second or more still pending, would be a page waking itself up.
        window.timers = { intervals: 0, pending: new Set() };
        const every = window.setInterval;
        window.setInterval = (...args) => {
          window.timers.intervals++;
          return every(...args);
        };
        const later = window.setTimeout;
        const clear = window.clearTimeout;
        window.setTimeout = (run, ms, ...rest) => {
          const id = later(
            (...a) => {
              window.timers.pending.delete(id);
              return typeof run === 'function' ? run(...a) : undefined;
            },
            ms,
            ...rest,
          );
          if (ms >= 1000) window.timers.pending.add(id);
          return id;
        };
        window.clearTimeout = id => {
          window.timers.pending.delete(id);
          return clear(id);
        };
        try {
          localStorage.setItem('forge.firstRun.lane', '1');
          if (dock) localStorage.setItem('forge.dock.needs-me', dock);
        } catch {}
      },
      layout && JSON.stringify(layout),
    );
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => message.type() === 'error' && errors.push(message.text()));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.protocol === 'data:') return route.continue();
      if (url.hostname !== 'forge.test') return route.abort();
      if (url.pathname === '/needs.html') return route.fulfill({ contentType: 'text/html', body: html });
      const file = join(out, url.pathname.slice(1));
      if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
      const contentType = file.endsWith('.js') ? 'text/javascript' : 'text/css';
      return route.fulfill({ contentType, body: readFileSync(file) });
    });
    await page.goto(`https://forge.test/needs.html?data=${data}&theme=${theme}`);
    await page
      .locator('.dock[data-dock] .region')
      .first()
      .waitFor({ timeout: 10_000 })
      .catch(error => assert.fail(`${error.message}\n${errors.join('\n')}`));
    if (width > 860) await page.locator('.fv-pic').waitFor();
    t.after(async () => {
      await context.close();
      assert.deepEqual(errors, [], 'no page errors');
    });
    return page;
  }
  /** What would wake an idle page: intervals ever set and long timeouts still pending. Idle costs nothing. */
  const idleTimers = page => page.evaluate(() => window.timers.intervals + window.timers.pending.size);
  const region = (page, name) => page.locator(`section.region[aria-label="${name}"]`);
  const box = async (page, name) => (await region(page, name).boundingBox()) ?? assert.fail(`no ${name}`);
  try {
    await t.test('every stop counts what the top bar counts, block for block (one source)', async t => {
      for (const data of ['busy', 'calm', 'worst']) {
        const page = await open(t, 1440, data);
        const counts = await page.evaluate(stops => {
          const text = el => el?.textContent?.trim();
          return stops.map(stop => ({
            stop,
            line: text(document.querySelector(`header.top .line a.stop[data-stop="${stop}"] .n`)),
            label: text(document.querySelector(`.fv-pic .fv-stn[data-stop="${stop}"] .c`)),
            blocks: String(document.querySelectorAll(`.fv-pic g[data-stop="${stop}"] .fv-cube`).length),
          }));
        }, STOPS);
        for (const { stop, line, label, blocks } of counts) {
          assert.equal(label, line, `${data} ${stop}: the picture says the top bar's count`);
          assert.equal(blocks, line, `${data} ${stop}: one block per open Lane`);
        }
        const lanesOpen = await region(page, 'On the way to main').locator('.ph .cnt').textContent();
        const standing = await page.locator('.needs-me').textContent();
        assert.match(
          standing,
          new RegExp(`${lanesOpen} Lanes open`),
          `${data}: the region counts the Lanes open`,
        );
        if (data === 'worst') assert.equal(lanesOpen, '56');
      }
      // A phone reads the same counts as flat rows.
      const phone = await open(t, 390, 'busy');
      const rows = await phone.locator('.flow-row .c').allTextContents();
      const line = await phone.locator('header.top .line a.stop .n').allTextContents();
      assert.deepEqual(rows.slice(0, 4), line, 'the phone rows count what the line counts');
    });

    await t.test('the home layout: picture left, Needs you right, FYI and Loose ends below', async t => {
      const ratio = async page => {
        const [flow, needs] = [await box(page, 'On the way to main'), await box(page, 'Needs you')];
        return flow.width / needs.width;
      };
      const calm = await open(t, 1440, 'calm');
      const [flow, needs, fyi, loose] = [
        await box(calm, 'On the way to main'),
        await box(calm, 'Needs you'),
        await box(calm, 'FYI'),
        await box(calm, 'Loose ends'),
      ];
      assert.ok(flow.x < needs.x && Math.abs(flow.y - needs.y) < 2, 'the picture is left of Needs you');
      assert.ok(fyi.y > flow.y + flow.height - 2 && Math.abs(fyi.x - flow.x) < 2, 'FYI is below the picture');
      assert.ok(loose.y > needs.y && Math.abs(loose.x - needs.x) < 2, 'Loose ends is below Needs you');
      assert.ok(Math.abs((await ratio(calm)) - 1.6) < 0.05, 'nothing waits: the picture has 1.6 : 1');
      assert.equal(await calm.locator('.fv-pic').getAttribute('data-tier'), '1');
      const busy = await open(t, 1440, 'busy');
      assert.ok(Math.abs((await ratio(busy)) - 1 / 1.1) < 0.05, 'something waits: Needs you gets 1.1 : 1');
      assert.equal(await busy.locator('.fv-pic').getAttribute('data-tier'), '0', 'the picture drops a size');
      const phone = await open(t, 390, 'busy');
      const order = await phone.evaluate(() =>
        [...document.querySelectorAll('section.region')]
          .map(section => [section.getAttribute('aria-label'), section.getBoundingClientRect().top])
          .sort((a, b) => a[1] - b[1])
          .map(([name]) => name),
      );
      assert.deepEqual(
        order,
        ['Needs you', 'On the way to main', 'FYI', 'Loose ends'],
        'a phone reads Needs you first',
      );
      for (const page of [busy, phone]) assert.equal(await idleTimers(page), 0, 'an idle page sets no timer');
    });

    await t.test(
      'widths 861 to 1440: no sideways scroll, the size step, labels inside the picture',
      async t => {
        for (const width of [861, 1000, 1100, 1440])
          for (const data of ['calm', 'busy']) {
            const page = await open(t, width, data);
            const seen = await page.evaluate(() => {
              const pic = document.querySelector('.fv-pic');
              const frame = pic.getBoundingClientRect();
              const out = [...pic.querySelectorAll('.fv-stn, .fv-tag, .fv-back')]
                .map(el => [el.textContent, el.getBoundingClientRect()])
                .filter(([, r]) => r.left < frame.left - 1 || r.right > frame.right + 1)
                .map(([text]) => text);
              return {
                scroll: document.documentElement.scrollWidth,
                inner: innerWidth,
                tier: pic.dataset.tier,
                width: frame.width,
                out,
              };
            });
            assert.ok(seen.scroll <= seen.inner, `no sideways scroll at ${width} ${data}`);
            assert.equal(Number(seen.tier), tierOf(seen.width), `size step at ${width} ${data}`);
            assert.deepEqual(seen.out, [], `labels inside the picture at ${width} ${data}`);
            if (shots)
              for (const theme of ['dark', 'light']) {
                await page.evaluate(value => (document.documentElement.dataset.theme = value), theme);
                await page.screenshot({ path: join(shots, `flow-${data}-${width}-${theme}.png`) });
              }
          }
      },
    );

    await t.test('a held block’s tag goes to its row under Needs you, which marks itself once', async t => {
      const page = await open(t, 1440, 'busy');
      const tag = page.locator('.fv-pic a.fv-tag').first();
      const id = await tag.getAttribute('data-for');
      await tag.click();
      assert.equal(new URL(page.url()).hash, '', 'the page stays: the row is reached in place');
      assert.equal(await page.locator(`#d-${id}`).getAttribute('class'), 'dec flow-here');
      assert.ok(
        (await region(page, 'Needs you').locator(`#d-${id}`).count()) === 1,
        'the row is under Needs you',
      );
      // Only what waits on the reader is tagged: an agent's conflict and a refusal are held blocks with no tag.
      assert.equal(await page.locator('.fv-pic .fv-tag').count(), 1);
    });

    await t.test(
      'worst case: long handles, right-to-left and long titles, asked ahead; axe in both themes',
      async t => {
        // Full width (a reader's layout): the largest size, where tags float above their blocks with the agent's name.
        const wide = await open(t, 1440, 'worst', {
          layout: { top: ['flow'], a: ['fyi'], b: ['needs', 'loose'] },
        });
        assert.equal(await wide.locator('.fv-pic').getAttribute('data-tier'), '2');
        const tags = await wide.evaluate(() => {
          const frame = document.querySelector('.fv-pic').getBoundingClientRect();
          return [...document.querySelectorAll('.fv-pic > .fv-tag')].map(el => {
            const r = el.getBoundingClientRect();
            return {
              text: el.textContent,
              inside: r.left >= frame.left && r.right <= frame.right,
              cut: [el, ...el.querySelectorAll('span')].some(part => part.scrollWidth > part.clientWidth),
            };
          });
        });
        assert.equal(tags.length, 2, 'the two Lanes waiting on the reader carry tags');
        assert.ok(
          tags.every(tag => tag.inside),
          JSON.stringify(tags),
        );
        assert.ok(
          tags.some(tag => tag.text.includes('an-agent-name') && tag.cut),
          'a long handle is cut, not spilled',
        );
        const needs = region(wide, 'Needs you');
        assert.ok(
          (await needs.locator('h3').allTextContents()).some(text => /تحديث/.test(text)),
          'a right-to-left title',
        );
        assert.equal(await needs.locator('h3[dir="auto"]').count(), await needs.locator('h3').count());
        assert.equal(await needs.locator('details.sumdec').count(), 1, 'the request asked ahead is listed');
        for (const width of [1440, 390]) {
          const page = width === 1440 ? wide : await open(t, width, 'worst');
          await page.addScriptTag({ path: axePath });
          for (const theme of ['dark', 'light']) {
            await page.evaluate(value => (document.documentElement.dataset.theme = value), theme);
            await page.evaluate(() => document.getAnimations().forEach(a => a.finish()));
            const [scroll, inner] = await page.evaluate(() => [
              document.documentElement.scrollWidth,
              innerWidth,
            ]);
            assert.ok(scroll <= inner, `no sideways scroll at ${width} ${theme}`);
            await page.evaluate(() => scrollTo(0, 0));
            const violations = await page.evaluate(async () => {
              const result = await window.axe.run(document, {
                runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
              });
              return result.violations
                .filter(v => v.id !== 'label-content-name-mismatch')
                .map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`);
            });
            assert.deepEqual(violations, [], `axe at ${width} ${theme} worst`);
            if (shots)
              await page.screenshot({
                path: join(shots, `flow-worst-${width}-${theme}.png`),
                fullPage: width === 390,
              });
          }
        }
      },
    );
  } finally {
    await browser.close();
    rmSync(out, { recursive: true, force: true });
  }
});
