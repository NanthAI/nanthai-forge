// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The design system's reference surface in a real browser (Item 6ebb58ab, lines moved from f97fb89d): the one reorder
// model (Enter picks up, arrows choose, Enter drops, Escape cancels; the handle's menu on a phone) with the drawn drop
// line, the screen and the announcement agreeing after every move; the dock moving a region between the full-width row
// and both columns, an empty zone drawn only while a region is carried; a press made before the behaviour layer
// arrives is carried out and attaching it moves nothing; axe and no sideways scroll at desk and phone width in both
// themes. Set FORGE_DS_SHOTS to a folder to also save the
// screenshots the lead reviews (both themes, mid-drag included); nothing is written otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { LAYER_GZIP_BUDGET, layerBundleReport } from '../scripts/ds-build-guard.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const shots = process.env.FORGE_DS_SHOTS || null;
const DESK = { width: 1440, height: 1000 };
const PHONE = { width: 390, height: 844 };
const LIST = 'section[aria-label="Plan, in order"]';
const DOCK = '.dock[data-dock]';
const PLAN = [
  'Split the import step',
  'Retry uploads after a dropped connection',
  'Show the landing queue on a phone',
  'Keep the reader’s place after a reload',
  'Drop the old export format',
];
const NUMBERS = PLAN.map((_, index) => String(index + 1));
const LAYOUT = { top: ['needs'], a: ['plan', 'lanes'], b: ['checks', 'notes'] };
const ORDINAL = new Intl.PluralRules('en-US', { type: 'ordinal' });
const ordinal = n => `${n}${{ one: 'st', two: 'nd', few: 'rd' }[ORDINAL.select(n)] ?? 'th'}`;

async function buildReference(out) {
  const { build } = await import(pathToFileURL(join(root, 'node_modules/vite/dist/node/index.js')).href);
  const result = await build({
    configFile: join(root, 'web/vite.config.ts'),
    root: join(root, 'web'),
    mode: 'hosted',
    logLevel: 'error',
    build: { outDir: out, emptyOutDir: true, rolldownOptions: { input: { ds: join(root, 'web/ds.html') } } },
  });
  const output = (Array.isArray(result) ? result[0] : result).output;
  const bundle = Object.fromEntries(output.map(item => [item.fileName, item]));
  const { layer } = layerBundleReport(bundle, LAYER_GZIP_BUDGET);
  assert.ok(layer, 'the reference surface uses the behaviour layer');
  return layer.files;
}

// --- reading the page ---------------------------------------------------------------------------------------------

const active = page =>
  page.evaluate(() => {
    const element = document.activeElement;
    return element?.getAttribute('aria-label') ?? element?.textContent?.trim() ?? '';
  });

/** The words in a part's live region; the invisible mark that makes a repeat audible is dropped. */
const said = async (page, scope) =>
  (await page.locator(`${scope} [data-announce]`).last().textContent()).replace(/\p{Cf}/gu, '');

/** Runs `act`, then waits until the part's live region changed (the same words twice still change it). */
async function hear(page, scope, act) {
  const read = scope => [...document.querySelectorAll(`${scope} [data-announce]`)].at(-1)?.textContent;
  const before = await page.evaluate(read, scope);
  await act();
  await page.waitForFunction(
    ([scope, before]) => {
      const now = [...document.querySelectorAll(`${scope} [data-announce]`)].at(-1)?.textContent;
      return now !== before;
    },
    [scope, before],
  );
  return said(page, scope);
}

/** Moves focus with Tab, as a keyboard user does, until the focused control's name is `label` (or one of them). */
async function tabTo(page, label) {
  const wanted = [label].flat();
  await page.locator('h1').click();
  const visited = [];
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab');
    const label = await active(page);
    if (wanted.includes(label)) return;
    visited.push(label.slice(0, 80));
  }
  assert.fail(`Tab never reached ${wanted.join(' or ')}. Visited: ${visited.join(' | ')}`);
}

/** The list as drawn: row names top to bottom, the numbers shown, and where the targeted drop line sits. */
const listState = page =>
  page.evaluate(() => {
    const children = [...document.querySelector('.ds-list[role=grid]').children];
    const rows = children.filter(child => child.classList.contains('ds-row'));
    const name = row => row.getAttribute('aria-label');
    const line = children.find(child => child.matches('.dropline[data-drop-target]'));
    let between = null;
    if (line) {
      const at = children.indexOf(line);
      const before = children
        .slice(0, at)
        .reverse()
        .find(child => child.classList.contains('ds-row'));
      const after = children.slice(at + 1).find(child => child.classList.contains('ds-row'));
      const y = line.getBoundingClientRect().top;
      between = {
        before: before ? name(before) : null,
        after: after ? name(after) : null,
        text: line.textContent,
        drawnBetween:
          (!before || before.getBoundingClientRect().bottom - 2 <= y) &&
          (!after || y <= after.getBoundingClientRect().top + 2),
      };
    }
    return {
      order: rows.map(name),
      numbers: rows.map(row => row.querySelector('.num')?.textContent),
      between,
    };
  });

/** Where the dropped row lands for a line drawn between `before` and `after` (counted without the row itself). */
function landsAt(start, moving, { before, after }) {
  const rest = start.filter(name => name !== moving);
  if (after === moving) return rest.indexOf(before) + 1;
  return after ? rest.indexOf(after) : rest.length;
}

const zones = page =>
  page.evaluate(() =>
    Object.fromEntries(
      ['top', 'a', 'b'].map(zone => [
        zone,
        [...document.querySelectorAll(`.zone[data-zone=${zone}] > .ds-region`)].map(region =>
          region.getAttribute('data-key'),
        ),
      ]),
    ),
  );

const waitForDropTarget = page =>
  page.waitForFunction(() => document.activeElement?.getAttribute('aria-label')?.startsWith('Insert'));

async function theme(page, name) {
  const key = page.getByRole('button', { name: 'Light' });
  if (((await key.getAttribute('aria-pressed')) === 'true') !== (name === 'light')) await key.click();
  await page.waitForFunction(value => document.documentElement.dataset.theme === value, name);
}

const shot = async (target, name) => {
  const whole = typeof target.goto === 'function'; // a page: the whole length, not one screen
  if (shots)
    await target.screenshot({ path: join(shots, `${name}.png`), ...(whole ? { fullPage: true } : {}) });
};

// --- the checks ---------------------------------------------------------------------------------------------------

test('the reference surface: reorder, dock, late layer, axe and widths in both themes', async t => {
  const engines = { chromium, firefox, webkit };
  const engineName = process.env.FORGE_DS_BROWSER || 'chromium';
  const engine = engines[engineName];
  assert.ok(engine, `Unknown reference browser: ${engineName}`);
  const executablePath = (engine === chromium && process.env.FORGE_UI_BROWSER) || engine.executablePath();
  if (!existsSync(executablePath)) {
    if (process.env.FORGE_DS_BROWSER) assert.fail(`Playwright ${engineName} is not installed.`);
    return t.skip('A test browser is not installed.');
  }
  const out = mkdtempSync(join(tmpdir(), 'forge-ds-reference-'));
  if (shots) mkdirSync(shots, { recursive: true });
  const layerFiles = await buildReference(out);
  const browser = engine === chromium ? await chromium.launch({ executablePath }) : await engine.launch();

  /** A fresh page on the built surface; `hold` keeps the layer's chunks back until the returned release is called. */
  async function open(t, viewport = DESK, { hold = false, touch = false } = {}) {
    const context = await browser.newContext({
      viewport,
      ...(touch ? { hasTouch: true, isMobile: true } : {}),
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let release = () => undefined;
    const gate = hold ? new Promise(resolve => (release = resolve)) : null;
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'forge.test') return route.abort();
      const path = url.pathname.slice(1) || 'ds.html';
      const file = join(out, path);
      if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
      if (gate && layerFiles.includes(path)) await gate;
      const contentType = file.endsWith('.js')
        ? 'text/javascript'
        : file.endsWith('.css')
          ? 'text/css'
          : 'text/html';
      return route.fulfill({ contentType, body: readFileSync(file) });
    });
    await page.goto('https://forge.test/ds.html');
    if (!hold) {
      await page.locator(`${DOCK} .ds-region`).first().waitFor();
      await page.locator('.ds-list[role=grid] > .ds-row').first().waitFor();
    }
    t.after(async () => {
      await context.close();
      assert.deepEqual(errors, [], 'no page errors');
    });
    return { page, release };
  }

  try {
    await t.test(
      'a press before the layer arrives is carried out, and attaching the layer moves nothing',
      async t => {
        const { page, release } = await open(t, DESK, { hold: true });
        await page.locator(`${LIST} [role=list] .ds-row`).first().waitFor();
        const boxes = () =>
          page.locator(`${LIST} .ds-row`).evaluateAll(rows =>
            rows.map(row => {
              const { left, top, height } = row.getBoundingClientRect();
              return [Math.round(left), Math.round(top), Math.round(height)];
            }),
          );
        const before = await boxes();
        await page.getByRole('button', { name: 'More' }).click();
        assert.equal(await page.getByRole('menu').count(), 0, 'no menu before the layer');
        release();
        await page.getByRole('menuitem', { name: 'Retry the check' }).waitFor({ timeout: 5000 });
        await page.keyboard.press('Escape');
        await page.locator('.ds-list[role=grid]').waitFor();
        assert.deepEqual(await boxes(), before, 'rows keep their place when the layer attaches');
      },
    );

    await t.test(
      'a Dock grip holds its place during attachment and supports menu moves and native drops at both widths',
      async t => {
        for (const viewport of [DESK, PHONE]) {
          const { page, release } = await open(t, viewport, { hold: true });
          const notes = page.getByRole('button', { name: 'Move Notes', exact: true });
          await notes.hover();
          const held = await notes.boundingBox();
          assert.ok(held);
          await page.mouse.down();
          try {
            release();
            await page.locator('.ds-list[role=grid] > .ds-row').first().waitFor();
            assert.equal(await page.locator(DOCK).count(), 0, 'the Dock grip does not swap during its press');
            assert.deepEqual(
              await notes.boundingBox(),
              held,
              `held grip at ${viewport.width}px keeps its place`,
            );
          } finally {
            await page.mouse.up();
          }
          const wide = page.getByRole('menuitem', { name: 'Full width' });
          await hear(page, DOCK, () => wide.click());
          assert.deepEqual((await zones(page)).top, ['needs', 'notes']);
          assert.equal(await page.getByRole('menu').count(), 0, 'the move does not reopen the initial menu');

          await notes.scrollIntoViewIfNeeded();
          const from = await notes.boundingBox();
          assert.ok(from);
          const x = from.x + from.width / 2;
          const y = from.y + from.height / 2;
          await page.mouse.move(x, y);
          await page.mouse.down();
          const moved = await hear(page, DOCK, async () => {
            try {
              await page.mouse.move(x + 16, y, { steps: 5 });
              await page.locator(`${DOCK}[data-carrying]`).waitFor();
              const plan = await page.getByRole('region', { name: 'Plan, in order' }).boundingBox();
              assert.ok(plan);
              const targetX = plan.x + plan.width / 2;
              const targetY = plan.y + 16;
              await page.mouse.move(targetX - 4, targetY, { steps: 10 });
              await page.mouse.move(targetX, targetY);
              await page
                .locator('[data-zone="a"] .dropline[data-drop-target]')
                .getByText('Notes, left column, 1st', { exact: true })
                .waitFor();
            } finally {
              await page.mouse.up();
            }
          });
          assert.equal(moved, 'Moved Notes to the left column, position 1 of 3.');
          assert.deepEqual(await zones(page), {
            top: ['needs'],
            a: ['notes', 'plan', 'lanes'],
            b: ['checks'],
          });
        }
      },
    );

    if (engine === chromium)
      await t.test('touch opens the Dock grip menu on a hybrid desktop and a cold phone', async t => {
        for (const viewport of [DESK, PHONE]) {
          const touchFirst = viewport === PHONE;
          const { page, release } = await open(t, viewport, { hold: touchFirst, touch: touchFirst });
          const notes = page.getByRole('button', { name: 'Move Notes', exact: true });
          assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), touchFirst);
          await notes.scrollIntoViewIfNeeded();
          const bounds = await notes.boundingBox();
          assert.ok(bounds, 'the Dock grip is visible');
          const cdp = await page.context().newCDPSession(page);
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }],
          });
          try {
            if (touchFirst) {
              release();
              await page.locator('.ds-list[role=grid] > .ds-row').first().waitFor();
              assert.equal(await page.locator(DOCK).count(), 0, 'the Dock waits for the active touch');
            }
          } finally {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          }
          const gripKind = touchFirst ? 'ds-move' : 'ds-drag';
          await page.locator(`${DOCK} .${gripKind}[aria-label="Move Notes"]`).waitFor();
          await hear(page, DOCK, () => page.getByRole('menuitem', { name: 'Full width' }).click());
          assert.deepEqual((await zones(page)).top, ['needs', 'notes']);
        }
      });

    await t.test(
      'keyboard reorder: the drop line, the screen and the announcement agree after every move',
      async t => {
        const moving = PLAN[1];
        for (const name of ['dark', 'light']) {
          // Start each theme with a fresh grid, before another drag can leave its grip focused.
          const { page } = await open(t);
          await theme(page, name);
          await tabTo(page, PLAN);
          await page.keyboard.press('Home');
          assert.equal(await active(page), PLAN[0]);
          await page.keyboard.press('ArrowDown');
          await page.keyboard.press('Tab');
          assert.equal(await active(page), `Move ${moving}`);
          const start = (await listState(page)).order;
          assert.deepEqual(start, PLAN);
          await page.keyboard.press('Enter');
          await waitForDropTarget(page);
          for (const key of ['ArrowDown', 'ArrowDown', 'ArrowUp']) {
            await page.keyboard.press(key);
            const { between } = await listState(page);
            assert.ok(between, `a drop line is drawn after ${key}`);
            assert.ok(
              between.drawnBetween,
              `the line is drawn between ${between.before} and ${between.after}`,
            );
            const place = landsAt(start, moving, between);
            assert.equal(
              between.text,
              `${moving}, ${ordinal(place + 1)}`,
              'the line names the place it lands',
            );
          }
          await shot(page.locator(LIST), `mid-drag-list-${name}`);
          const { between } = await listState(page);
          const heard = await hear(page, LIST, () => page.keyboard.press('Enter'));
          const after = await listState(page);
          const position = after.order.indexOf(moving) + 1;
          assert.equal(position, landsAt(start, moving, between) + 1, 'it landed where the line said');
          assert.equal(
            heard,
            `Moved ${moving} to position ${position} of ${PLAN.length}.`,
            'the words match the screen',
          );
          assert.deepEqual(after.numbers, NUMBERS, 'the numbers follow the order');
          assert.equal(await active(page), moving, 'focus stays on the moved row');

          // Escape puts it back where it was and says nothing new
          const quiet = await said(page, LIST);
          await page.keyboard.press('Tab');
          assert.equal(await active(page), `Move ${moving}`);
          await page.keyboard.press('Enter');
          await waitForDropTarget(page);
          await page.keyboard.press('ArrowUp');
          await page.keyboard.press('ArrowUp');
          await page.keyboard.press('Escape');
          assert.deepEqual((await listState(page)).order, after.order, 'Escape cancels');
          assert.equal(await said(page, LIST), quiet);
          assert.equal(await active(page), `Move ${moving}`, 'focus is back on the handle');

          // Return the row to its original place using the same keys.
          await page.keyboard.press('Enter');
          await waitForDropTarget(page);
          const home = `${moving}, ${ordinal(start.indexOf(moving) + 1)}`;
          for (let i = 0; i < PLAN.length && (await listState(page)).between?.text !== home; i++)
            await page.keyboard.press('ArrowUp');
          await hear(page, LIST, () => page.keyboard.press('Enter'));
          assert.deepEqual((await listState(page)).order, start);
        }
      },
    );

    await t.test('on a phone the handle is a menu, and its moves are announced and redrawn', async t => {
      const { page } = await open(t, PHONE);
      const last = PLAN[4];
      const handle = page.locator(`${LIST} .ds-move[aria-label="Move ${last}"]`);
      assert.ok(await handle.isVisible(), 'the menu handle shows on a phone');
      assert.ok(!(await page.locator(`${LIST} .ds-drag[aria-label="Move ${last}"]`).isVisible()));
      await handle.click();
      const heard = await hear(page, LIST, () => page.getByRole('menuitem', { name: 'To the top' }).click());
      const after = await listState(page);
      assert.equal(after.order[0], last);
      assert.deepEqual(after.numbers, NUMBERS);
      assert.equal(heard, `Moved ${last} to position 1 of ${PLAN.length}.`);
      await handle.click();
      const top = page.getByRole('menuitem', { name: 'To the top' });
      assert.equal(await top.getAttribute('aria-disabled'), 'true', 'the menu follows the new order');
      await page.keyboard.press('Escape');
    });

    await t.test('the dock moves a region between the full-width row and the columns', async t => {
      const { page } = await open(t);
      assert.deepEqual(await zones(page), LAYOUT);
      await tabTo(page, 'Move Checks');
      await page.keyboard.press('Enter');
      await waitForDropTarget(page);
      await page.keyboard.press('Tab'); // Tab carries the region to the next zone's places
      const line = page.locator('.zone[data-zone=top] .dropline[data-drop-target]');
      assert.equal(await line.textContent(), 'Checks, full-width row, 2nd');
      await shot(page.locator(DOCK), 'mid-drag-dock-dark');
      const heard = await hear(page, DOCK, () => page.keyboard.press('Enter'));
      assert.equal(heard, 'Moved Checks to the full-width row, position 2 of 2.');
      assert.deepEqual(await zones(page), { top: ['needs', 'checks'], a: ['plan', 'lanes'], b: ['notes'] });
      await page.reload();
      await page.locator('.ds-list[role=grid]').waitFor();
      assert.deepEqual((await zones(page)).top, ['needs', 'checks'], 'the layout is kept on this browser');

      const phone = (await open(t, PHONE)).page;
      const menu = async (region, action) => {
        await phone.getByRole('button', { name: `Move ${region}`, exact: true }).click();
        return hear(phone, DOCK, () => phone.getByRole('menuitem', { name: action }).click());
      };
      assert.equal(
        await menu('Notes', 'Into the left column'),
        'Moved Notes to the left column, position 1 of 3.',
      );
      assert.deepEqual((await zones(phone)).a, ['notes', 'plan', 'lanes']);
      assert.equal(await menu('Notes', 'Full width'), 'Moved Notes to the full-width row, position 2 of 2.');
      assert.equal(await menu('Notes', 'Up one'), 'Moved Notes to the full-width row, position 1 of 2.');
      assert.deepEqual(await zones(phone), { top: ['notes', 'needs'], a: ['plan', 'lanes'], b: ['checks'] });
      assert.equal(await menu('Plan, in order', 'Reset layout'), 'Layout reset.');
      assert.deepEqual(await zones(phone), LAYOUT);
    });

    await t.test('keyboard Undo stays actionable at expiry and returns focus to the moved grip', async t => {
      const { page } = await open(t);
      await page.clock.install();
      const moveChecks = async () => {
        await page.locator(`${DOCK} .ds-drag[aria-label="Move Checks"]`).focus();
        await page.keyboard.press('Enter');
        await waitForDropTarget(page);
        await page.keyboard.press('Tab');
        await hear(page, DOCK, () => page.keyboard.press('Enter'));
        assert.deepEqual((await zones(page)).top, ['needs', 'checks']);
        // Finish the grid's post-drop focus handoff before moving focus to a toast action.
        await page.clock.runFor(100);
      };
      const toast = page.locator('.dock-toast');
      const activate = async name => {
        await toast.getByRole('button', { name }).focus();
        await page.clock.fastForward(10_000);
        assert.equal(await active(page), name, 'the toast stays while its button has focus');
        await hear(page, DOCK, () => page.keyboard.press('Enter'));
        assert.deepEqual(await zones(page), LAYOUT);
        await page.clock.runFor(100);
        assert.equal(await active(page), 'Move Checks', 'focus returns to the grip after the layout changes');
      };
      await moveChecks();
      await activate('Undo');
      await moveChecks();
      await activate('Reset layout');
    });

    await t.test('a saved Dock layout stays with its viewer on the same browser', async t => {
      const { page } = await open(t);
      const show = async viewer => {
        await page.goto(`https://forge.test/ds.html?viewer=${viewer}`);
        await page.locator('.ds-list[role=grid]').waitFor();
        return zones(page);
      };
      assert.deepEqual(await show('sample-one'), LAYOUT);
      await page.locator(`${DOCK} .ds-drag[aria-label="Move Notes"]`).click();
      await hear(page, DOCK, () => page.getByRole('menuitem', { name: 'Full width' }).click());
      assert.deepEqual(await show('sample-two'), LAYOUT);
      assert.deepEqual(await show('sample-one'), {
        top: ['needs', 'notes'],
        a: ['plan', 'lanes'],
        b: ['checks'],
      });
    });

    await t.test(
      'an empty zone is not drawn at rest and comes back as the drop target while a region is carried',
      async t => {
        // Item 6ebb58ab (owner 2026-11-19): a column with no regions drew "Drop a region here" beside the other column
        // on every docked screen. At rest the other column takes the full width; while a region is carried the empty
        // zone is back, says so, and takes the drop.
        // The region carried is first in its column: Tab reaches a column's first region (arrows reach the rest).
        const ONE_COLUMN = { top: ['needs'], a: ['checks', 'plan', 'lanes', 'notes'], b: [] };
        const drawn = page =>
          page.evaluate(() => {
            const shown = el => !!el && el.getClientRects().length > 0;
            const dock = document.querySelector('.dock[data-dock]').getBoundingClientRect();
            const a = document.querySelector('.zone[data-zone=a] > .ds-region').getBoundingClientRect();
            return {
              empty: [...document.querySelectorAll('.zone-empty')].filter(shown).map(el => el.textContent),
              b: shown(document.querySelector('.zone[data-zone=b]')),
              full: Math.abs(a.width - dock.width) < 1,
            };
          });
        for (const [viewport, width] of [
          [DESK, 'desk'],
          [PHONE, 'phone'],
        ]) {
          const { page } = await open(t, viewport);
          await page.evaluate(
            layout => localStorage.setItem('forge.dock.reference', JSON.stringify(layout)),
            ONE_COLUMN,
          );
          await page.reload();
          await page.locator('.ds-list[role=grid]').waitFor();
          assert.deepEqual(await zones(page), ONE_COLUMN);
          assert.deepEqual(await drawn(page), { empty: [], b: false, full: true }, `${width}: at rest`);
          await shot(page.locator(DOCK), `dock-one-column-${width}-dark`);
          await theme(page, 'light');
          assert.deepEqual(
            await drawn(page),
            { empty: [], b: false, full: true },
            `${width}: at rest, light`,
          );
          await shot(page.locator(DOCK), `dock-one-column-${width}-light`);
          await tabTo(page, 'Move Checks');
          await page.keyboard.press('Enter');
          await waitForDropTarget(page);
          const carried = await drawn(page);
          assert.deepEqual(
            carried.empty,
            ['Drop a region here'],
            'the empty zone is back while Checks is carried',
          );
          assert.equal(carried.b, true);
          for (let i = 0; i < 6; i++) {
            if (await page.evaluate(() => document.activeElement?.closest('.zone')?.dataset.zone === 'b'))
              break;
            await page.keyboard.press('Tab');
          }
          await shot(page.locator(DOCK), `mid-drag-empty-zone-${width}-light`);
          const heard = await hear(page, DOCK, () => page.keyboard.press('Enter'));
          assert.equal(heard, 'Moved Checks to the right column, position 1 of 1.');
          assert.deepEqual(await zones(page), {
            top: ['needs'],
            a: ['plan', 'lanes', 'notes'],
            b: ['checks'],
          });
          const after = await drawn(page);
          assert.deepEqual(
            [after.empty, after.b, after.full],
            [[], true, viewport === PHONE],
            'both zones hold regions, stacked only at phone width',
          );
          // Carried and put back: the empty zone shuts again.
          const notesFirst = { top: ['needs'], a: ['notes', 'plan', 'lanes', 'checks'], b: [] };
          await page.evaluate(
            layout => localStorage.setItem('forge.dock.reference', JSON.stringify(layout)),
            notesFirst,
          );
          await page.reload();
          await page.locator('.ds-list[role=grid]').waitFor();
          assert.deepEqual(await drawn(page), { empty: [], b: false, full: true });
          await tabTo(page, 'Move Notes');
          await page.keyboard.press('Enter');
          await waitForDropTarget(page);
          assert.deepEqual((await drawn(page)).empty, ['Drop a region here']);
          await page.keyboard.press('Escape');
          await page.waitForFunction(() => !document.querySelector('.zone-empty')?.getClientRects().length);
          assert.deepEqual(
            await drawn(page),
            { empty: [], b: false, full: true },
            'at rest again after Escape',
          );
        }
      },
    );

    await t.test('a fold held by the screen starts folded and the screen sees it open', async t => {
      const { page } = await open(t);
      const fold = page.locator('section.region[aria-label="Notes"] button.fold');
      assert.equal(await fold.getAttribute('aria-expanded'), 'false');
      assert.equal(await page.getByText('Read when opened.').count(), 0, 'nothing is read while folded');
      await fold.click();
      assert.equal(await fold.getAttribute('aria-expanded'), 'true');
      await page.getByText('Read when opened.').waitFor();
      await page.reload();
      await page.getByText('Read when opened.').waitFor();
      await fold.click();
    });

    await t.test('axe and widths: both themes, desk and phone, folds and the sheet open', async t => {
      for (const viewport of [DESK, PHONE]) {
        const { page } = await open(t, viewport);
        for (const fold of await page.locator('button.fold[aria-expanded="false"]').all()) await fold.click();
        await page.addScriptTag({ path: axePath });
        const light = page.getByRole('button', { name: 'Light', exact: true });
        const transitions = () =>
          light.evaluate(key => getComputedStyle(key).transitionProperty.split(/,\s*/));
        assert.deepEqual(
          await transitions(),
          ['transform'],
          'the theme switch applies ink and fill together',
        );
        for (const name of ['dark', 'light']) {
          await theme(page, name);
          const [scroll, inner] = await page.evaluate(() => [
            document.documentElement.scrollWidth,
            innerWidth,
          ]);
          assert.ok(scroll <= inner, `no sideways scroll at ${viewport.width} ${name}: ${scroll} > ${inner}`);
          const violations = await page.evaluate(async () => {
            const result = await window.axe.run(document, {
              runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
            });
            return result.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`);
          });
          assert.deepEqual(violations, [], `axe at ${viewport.width} ${name}`);
          await shot(page, `reference-${viewport.width}-${name}`);
        }
        await page.getByRole('button', { name: 'Choose' }).click();
        await page.getByRole('dialog').waitFor();
        const dialog = await page.evaluate(async () => {
          const result = await window.axe.run(document.querySelector('[role=dialog]'));
          return result.violations.map(v => v.id);
        });
        assert.deepEqual(dialog, [], `axe on the sheet at ${viewport.width}`);
        await shot(page, `sheet-${viewport.width}-light`);
        await page.keyboard.press('Escape');
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await theme(page, 'dark');
        assert.deepEqual(await transitions(), ['none'], 'reduced motion also removes the key press movement');
      }
    });
  } finally {
    await browser.close();
    rmSync(out, { recursive: true, force: true });
  }
});
