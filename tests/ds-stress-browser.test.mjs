// SPDX-License-Identifier: Apache-2.0
// Cross-engine reflow and focus checks on built screens with synthetic data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, firefox, webkit } from 'playwright';
import { chromiumLaunchOptions } from './browser-runtime.mjs';
import { buildFixture, serveFixture } from './browser/ds-screens-fixture.mjs';
import { reflowViewport, zoomContext } from './browser/ds-zoom.mjs';

const screens = {
  reference: { path: '/ds.html?data=worst', ready: '.ds-list[role=grid]', sample: '123,456' },
  needs: { path: '/sample-one/synthetic/needs?data=stress', ready: '.dock[data-dock]', sample: '123,456' },
  lanes: { path: '/sample-one/synthetic/lanes', ready: '.ds-region .yard', sample: '👩🏽‍💻 王秀英' },
  plan: { path: '/sample-one/synthetic/plan', ready: '.plan .ds-list[role=grid]', sample: '123,456' },
};

async function checkHead(page, name, width) {
  const tools = page.locator('.head > .tools > *:visible');
  assert.ok(await tools.count(), `${name}: page tools are visible`);
  if (name === 'you') assert.equal(await tools.count(), 4, 'You shows all four tools');
  const layout = await page.locator('.head > .sit').evaluate(sentence => {
    const ruler = document.createElement('span');
    ruler.style.cssText = 'position:absolute; width:20ch';
    sentence.append(ruler);
    const minimum = ruler.getBoundingClientRect().width;
    ruler.remove();
    const range = document.createRange();
    const text = document.createTreeWalker(sentence, NodeFilter.SHOW_TEXT);
    const splitWords = [];
    for (let node = text.nextNode(); node; node = text.nextNode()) {
      for (const word of node.textContent.matchAll(/\p{L}+/gu)) {
        range.setStart(node, word.index);
        range.setEnd(node, word.index + word[0].length);
        if (range.getClientRects().length > 1) splitWords.push(word[0]);
      }
    }
    const box = sentence.getBoundingClientRect();
    const toolsBox = sentence.nextElementSibling.getBoundingClientRect();
    return { width: box.width, minimum, splitWords, toolsBelow: toolsBox.top >= box.bottom };
  });
  assert.ok(
    layout.width >= layout.minimum,
    `${name}: sentence width ${layout.width}px < 20ch (${layout.minimum}px)`,
  );
  assert.deepEqual(layout.splitWords, [], `${name}: sentence wraps at word boundaries`);
  if (name === 'you' && width === 1024)
    assert.ok(layout.toolsBelow, 'wide You tools move below the sentence');
  if (name === 'place' && width === 1280)
    assert.ok(!layout.toolsBelow, 'short tools stay beside the sentence');
  await checkReflow(page, name);
}

async function checkPanelTitles(page) {
  for (const name of ['Needs you', 'FYI', 'On the way to main']) {
    const title = page.locator('.ph').getByRole('heading', { name, exact: true });
    const lines = await title.evaluate(heading => {
      const range = document.createRange();
      range.selectNodeContents(heading.querySelector('button') ?? heading);
      return range.getClientRects().length;
    });
    assert.equal(lines, 1, `${name} fits on one line`);
  }
}

async function checkReflow(page, label) {
  const layout = await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const pageWidth = document.documentElement.clientWidth;
    const scrolledWidth = document.documentElement.scrollWidth;
    const clipped = [
      ...document.querySelectorAll('button, a[href], input, select, textarea, summary, [role=menuitem]'),
    ]
      .filter(control => !control.closest('.scroll, .code, [inert], [aria-hidden=true]'))
      .flatMap(control => {
        const box = control.getBoundingClientRect();
        if (!box.width || !box.height || control.matches('.skip:not(:focus)')) return [];
        return box.left < -1 || box.right > pageWidth + 1
          ? [
              {
                name: control.getAttribute('aria-label') || control.textContent.trim() || control.className,
                css: control.className,
                bounds: [box.left, box.right].map(Math.round),
              },
            ]
          : [];
      });
    const outside =
      scrolledWidth > pageWidth
        ? [...document.querySelectorAll('*')]
            .flatMap(el => {
              if (el.closest('.scroll, .code, [aria-hidden=true], [hidden]')) return [];
              const r = el.getBoundingClientRect();
              return r.width && r.height && r.right > pageWidth + 1
                ? [[el.tagName, el.getAttribute('class'), Math.round(r.right)]]
                : [];
            })
            .slice(0, 12)
        : [];
    return { pageWidth, scrolledWidth, clipped, outside };
  });
  assert.deepEqual(
    { overflow: Math.max(0, layout.scrolledWidth - layout.pageWidth), clipped: layout.clipped.slice(0, 8) },
    { overflow: 0, clipped: [] },
    `${label} ${JSON.stringify(layout.outside)}`,
  );
}

async function checkTabOrder(page, label, steps = 35) {
  const clipped = [];
  for (let step = 0; step < steps; step++) {
    await page.keyboard.press('Tab');
    const focus = await page.evaluate(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const el = document.activeElement;
      if (el === document.body) return { end: true };
      const box = el.getBoundingClientRect();
      const x = (Math.max(0, box.left) + Math.min(box.right, innerWidth)) / 2;
      const top = Math.max(0, box.top);
      const height = Math.min(box.bottom, innerHeight) - top;
      const visible = document.elementFromPoint(x, top + height / 2);
      if (
        height > 0 &&
        (el.contains(visible) ||
          (box.height > innerHeight &&
            [0.25, 0.75].some(at => el.contains(document.elementFromPoint(x, top + height * at)))))
      )
        return null;
      return {
        name: el.getAttribute('aria-label') || el.textContent.trim().slice(0, 80),
        by: visible?.closest('.top, .tabs, .line.phone, .bulk')?.className ?? visible?.className ?? null,
        css: el.className,
        box: [box.x, box.y, box.width, box.height].map(Math.round),
      };
    });
    if (focus?.end) break;
    if (focus) clipped.push(focus);
  }
  assert.deepEqual(clipped, [], `${label}: Tab focus is visible`);
}

async function carryWithMouse(page, dock, grip, destination, offset, ready) {
  await grip.hover();
  const source = await grip.boundingBox();
  assert.ok(source);
  const x = source.x + source.width / 2;
  const y = source.y + source.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  try {
    await page.mouse.move(x + 12, y, { steps: 4 });
    await dock.and(page.locator('[data-native-drag]')).waitFor();
    const held = await grip.boundingBox();
    assert.ok(
      held && Math.abs(held.x - source.x) < 1 && Math.abs(held.y - source.y) < 1,
      `grip moved during pickup: ${JSON.stringify({ source, held })}`,
    );
    await destination.scrollIntoViewIfNeeded();
    const box = await destination.boundingBox();
    assert.ok(box);
    const toX = box.x + box.width / 2;
    const toY = box.y + (offset ?? box.height / 2);
    await page.mouse.move(toX - 4, toY, { steps: 8 });
    await page.mouse.move(toX, toY);
    await ready();
  } finally {
    await page.mouse.up();
  }
}

test('design system stress text, zoom reflow and maximum-page Dock reorder', async t => {
  const engines = { chromium, firefox, webkit };
  const selected = process.env.FORGE_DS_BROWSER;
  assert.ok(!selected || Object.hasOwn(engines, selected), `Unknown reference browser: ${selected}`);
  const out = mkdtempSync(join(tmpdir(), 'forge-ds-stress-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const html = await buildFixture(out);
  for (const [name, engine] of Object.entries(engines)) {
    if (selected && selected !== name) continue;
    await t.test(name, async t => {
      const launchOptions = engine === chromium ? chromiumLaunchOptions(t) : {};
      if (!launchOptions) {
        if (selected) assert.fail(`Playwright ${name} is not installed.`);
        return;
      }
      if (engine !== chromium && !existsSync(engine.executablePath())) {
        if (selected) assert.fail(`Playwright ${name} is not installed.`);
        return t.skip(`Playwright ${name} is not installed.`);
      }
      // The browser-shard inventory guard detects the Chromium launch in the suite source.
      const browser = engine === chromium ? await chromium.launch(launchOptions) : await engine.launch();
      t.after(() => browser.close());
      for (const width of [768, 1024, 1280]) {
        await t.test(`page heads and Needs me panel titles stay readable at ${width}px`, async t => {
          const page = await browser.newPage({ viewport: { width, height: 900 } });
          t.after(() => page.close());
          page.setDefaultTimeout(5000);
          await serveFixture(page, out, html, '/sample-one/synthetic/needs?data=busy');
          await t.test('Needs me panel titles fit on one line', async () => {
            await page.getByRole('heading', { name: 'On the way to main', exact: true }).waitFor();
            await page.evaluate(() => document.fonts.ready);
            await checkPanelTitles(page);
          });
          // The placeholder of a place without its own screen has no tools since Item b0704959 (no old screen to open).
          for (const screen of ['you', 'secrets', 'check']) {
            await t.test(`${screen} keeps a readable sentence beside its tools or above them`, async () => {
              await page.goto(`https://forge.test/${screen}`);
              await page.locator('.head > .tools > *').first().waitFor();
              await page.evaluate(() => document.fonts.ready);
              await checkHead(page, screen, width);
            });
          }
        });
      }
      for (const width of [390, 1440]) {
        await t.test(`keyboard and pointer reorder all seven Billing Dock regions at ${width}px`, async t => {
          const context = await browser.newContext({
            viewport: { width, height: width === 390 ? 844 : 1000 },
          });
          t.after(() => context.close());
          const page = await context.newPage();
          page.setDefaultTimeout(5000);
          // Billing owner view is the longest Dock. Put all seven regions together so carrying one also reveals
          // its empty drop zones. Exercise the actual Billing screen and the persisted layout it accepts.
          await context.addInitScript(() => {
            localStorage.setItem(
              'forge.dock.billing.@sample-owner.owner',
              JSON.stringify({
                top: [],
                a: ['month', 'projects', 'months', 'plan', 'next', 'pay', 'invoices'],
                b: [],
              }),
            );
          });
          await serveFixture(page, out, html, '/billing?view=owner');
          const dock = page.locator('.dock[data-dock]');
          const rendered = dock.locator('.zone[data-zone=a] > .ds-region');
          const order = () => rendered.evaluateAll(regions => regions.map(region => region.dataset.key));
          const original = ['month', 'projects', 'months', 'plan', 'next', 'pay', 'invoices'];
          const grip = dock.getByRole('button', { name: 'Move Payment', exact: true });
          await grip.waitFor();
          assert.deepEqual(await order(), original);
          const target = dock.locator('.dropline[data-drop-target]');
          const announcement = dock.locator('[data-announce]').last();
          const upOne = ['month', 'projects', 'months', 'plan', 'pay', 'next', 'invoices'];

          await rendered.nth(5).focus();
          await page.keyboard.press('Tab');
          assert.equal(
            await page.evaluate(() => document.activeElement.getAttribute('aria-label')),
            'Move Payment',
          );
          await page.keyboard.press('Enter');
          await page.locator('.dock[data-carrying]').waitFor();
          await page.keyboard.press('ArrowUp');
          await target.waitFor({ state: 'attached' });
          for (
            let i = 0;
            i < original.length && !(await target.textContent()).includes('left column, 5th');
            i++
          ) {
            await page.keyboard.press('ArrowUp');
          }
          assert.equal(await target.textContent(), 'Payment, left column, 5th');
          await page.keyboard.press('Enter');
          await announcement
            .filter({ hasText: 'Moved Payment to the left column, position 5 of 7.' })
            .waitFor({ state: 'attached', timeout: 5000 });
          assert.deepEqual(await order(), upOne);

          const invoice = dock.getByRole('heading', { name: 'Invoices', exact: true });
          await carryWithMouse(page, dock, grip, invoice, 4, () =>
            target.getByText('Payment, left column, 6th', { exact: true }).waitFor(),
          );
          await announcement
            .filter({ hasText: 'Moved Payment to the left column, position 6 of 7.' })
            .waitFor({ state: 'attached', timeout: 5000 });
          assert.deepEqual(await order(), original);

          const emptyTop = dock.locator('.zone[data-zone=top]');
          await carryWithMouse(
            page,
            dock,
            dock.getByRole('button', { name: 'Move This month', exact: true }),
            emptyTop.getByText('Drop a region here'),
            undefined,
            () => emptyTop.and(page.locator('[data-drop-target]')).waitFor(),
          );
          await announcement
            .filter({ hasText: 'Moved This month to the full-width row, position 1 of 1.' })
            .waitFor({ state: 'attached' });
          assert.equal(await emptyTop.locator('.ds-region').getAttribute('data-key'), 'month');
          assert.deepEqual(await order(), original.slice(1));
        });
      }
      for (const zoom of [2, 4]) {
        const { context, applyZoom } = await zoomContext(browser, name, out, zoom, launchOptions);
        t.after(() => context.close());
        const mode = name === 'webkit' ? 'reflow viewport' : 'browser zoom';
        for (const [screen, spec] of Object.entries(screens)) {
          await t.test(`${screen} at ${zoom * 100}% ${mode}`, async t => {
            const page = await context.newPage();
            t.after(() => page.close());
            const errors = [];
            let phase = 'initial render';
            page.on('pageerror', error => {
              // WebKit can defer a notification on menu mount. The keyboard and geometry assertions below
              // check the result after that delivery, and any other page error still fails.
              if (
                name === 'webkit' &&
                phase === 'opening the bulk menu' &&
                error.message === 'ResizeObserver loop completed with undelivered notifications.'
              ) {
                t.diagnostic('WebKit deferred a ResizeObserver notification while positioning the menu.');
                return;
              }
              errors.push(`${phase}: ${error.message}`);
            });
            await serveFixture(page, out, html, spec.path);
            await applyZoom(page);
            await page.waitForFunction(
              ({ width, height }) => innerWidth === width && innerHeight === height,
              reflowViewport(zoom),
              { timeout: 5000 },
            );
            await page.locator(spec.ready).first().waitFor({ timeout: 5000 });
            await page.getByText(spec.sample, { exact: true }).first().waitFor({ timeout: 5000 });
            if (screen === 'reference') {
              const notes = page.getByRole('button', { name: 'Notes', exact: true });
              if ((await notes.getAttribute('aria-expanded')) === 'false') await notes.press('Enter');
              await page.getByText('Read when opened.').waitFor({ timeout: 5000 });
              assert.deepEqual(
                await page
                  .locator('.tbl tr td:first-child')
                  .evaluateAll(cells =>
                    cells
                      .filter(cell => cell.scrollWidth > cell.clientWidth + 1)
                      .map(cell => cell.textContent),
                  ),
                [],
                'unbroken table text wraps inside its cell',
              );
              assert.equal(await page.locator('.ds-row .av').nth(4).textContent(), '👩🏽‍💻');
              assert.equal(await page.locator('.ds-row .av').nth(5).textContent(), 'j');
              await page.evaluate(() => {
                document.activeElement.blur();
                window.scrollTo(0, 0);
              });
            }
            await checkReflow(page, screen);
            await checkTabOrder(page, screen);
            if (screen === 'plan') {
              phase = 'selecting a Plan Item';
              await page.getByRole('checkbox', { name: /^Select Aleksandra/ }).press('Space');
              const under = page.getByRole('button', { name: 'Put under…' });
              phase = 'opening the bulk menu';
              await under.press('Enter');
              const menu = page.getByRole('menu');
              await menu.getByRole('menuitem', { name: /^[0-9a-f]{64}$/ }).waitFor();
              await checkReflow(page, 'Plan bulk menu with a 64-character identifier');
              phase = 'moving to the last menu item';
              await page.keyboard.press('End');
              const last = menu.getByRole('menuitem', { name: 'Top level (no parent)' });
              assert.ok(
                await last.evaluate(async el => {
                  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                  const rect = el.getBoundingClientRect();
                  const menu = el.closest('.ds-pop').getBoundingClientRect();
                  return (
                    document.activeElement === el &&
                    rect.top >= menu.top - 1 &&
                    rect.bottom <= menu.bottom + 1
                  );
                }),
                'the last menu choice scrolls into view',
              );
              phase = 'closing the bulk menu';
              await page.keyboard.press('Escape');
              await menu.waitFor({ state: 'hidden' });
              await page.getByRole('button', { name: 'Clear the selection' }).focus();
              await checkTabOrder(page, 'Plan with the bulk bar open', 8);
            }
            if (screen === 'reference') {
              await page.getByRole('button', { name: 'Choose', exact: false }).press('Enter');
              const dialog = page.getByRole('dialog');
              await dialog.waitFor();
              await checkReflow(page, 'open sheet');
              await page.keyboard.press('Tab');
              assert.ok(
                await dialog.evaluate(el => el.contains(document.activeElement)),
                'sheet keeps focus',
              );
              await page.keyboard.press('Escape');
              await dialog.waitFor({ state: 'hidden' });
            }
            assert.deepEqual(errors, []);
          });
        }
      }
    });
  }
});
