// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';

const HOME = { top: [], a: ['flow', 'fyi'], b: ['needs', 'loose'] };
const FLOW = 'On the way to main';
const region = (page, title) => page.getByRole('region', { name: title, exact: true });
const grip = (page, title) => region(page, title).getByRole('button', { name: `Move ${title}`, exact: true });

function readLayout() {
  return Object.fromEntries(
    ['top', 'a', 'b'].map(zone => [
      zone,
      [...document.querySelectorAll(`.dock[data-dock] > [data-zone="${zone}"] > .ds-region`)].map(
        row => row.dataset.key,
      ),
    ]),
  );
}

async function seeLayout(page, expected) {
  const ready = await page
    .waitForFunction(
      layout =>
        Object.entries(layout).every(([zone, ids]) => {
          const rows = [
            ...document.querySelectorAll(`.dock[data-dock] > [data-zone="${zone}"] > .ds-region`),
          ];
          return rows.length === ids.length && rows.every((row, index) => row.dataset.key === ids[index]);
        }),
      expected,
      { timeout: 5000 },
    )
    .catch(() => null);
  if (!ready) assert.deepEqual(await page.evaluate(readLayout), expected, 'the displayed dock layout');
}

async function dragBefore(page, title, anchor, zone, position) {
  const source = grip(page, title);
  await source.scrollIntoViewIfNeeded();
  const from = await source.boundingBox();
  assert.ok(from, `${title} has a visible grip`);
  const x = from.x + from.width / 2;
  const y = from.y + from.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  try {
    await page.mouse.move(x + 16, y, { steps: 5 });
    // The empty full-width target appears on pickup. Hit the destination in its resting column.
    await page.getByText('Drop a region here', { exact: true }).waitFor({ timeout: 4000 });
    const to = await region(page, anchor).boundingBox();
    assert.ok(to, `${anchor} is a visible destination`);
    const targetX = to.x + to.width / 2;
    const targetY = to.y + Math.min(24, to.height / 4);
    await page.mouse.move(targetX - 4, targetY, { steps: 15 });
    await page.mouse.move(targetX, targetY);
    await page
      .locator(`[data-zone="${zone}"] .dropline[data-drop-target]`)
      .getByText(`${title}, right column, ${position}`, { exact: true })
      .waitFor({ timeout: 4000 });
  } finally {
    await page.mouse.up();
  }
}

const writes = page => page.evaluate(() => window.dockWrites);

export async function checkDesktopDock(page) {
  await seeLayout(page, HOME);
  assert.deepEqual(await writes(page), [], 'reading the dock writes nothing');

  const across = { top: [], a: ['fyi'], b: ['flow', 'needs', 'loose'] };
  await dragBefore(page, FLOW, 'Needs you', 'b', '1st');
  await seeLayout(page, across);
  assert.deepEqual(await writes(page), ['set'], 'one write for a cross-column drop');

  const reordered = { top: [], a: ['fyi'], b: ['needs', 'flow', 'loose'] };
  await page.getByText('Drop a region here', { exact: true }).waitFor({ state: 'hidden' });
  await dragBefore(page, 'Needs you', FLOW, 'b', '1st');
  await seeLayout(page, reordered);
  assert.deepEqual(await writes(page), ['set', 'set'], 'one write for a same-column drop');
  await page.reload();
  await seeLayout(page, reordered);
  assert.deepEqual(await writes(page), [], 'reloading writes nothing');

  await grip(page, FLOW).click();
  await page.getByRole('menuitem', { name: 'Into the left column' }).click();
  await seeLayout(page, HOME);
  await page.getByRole('menu', { name: `Move ${FLOW}` }).waitFor({ state: 'hidden' });
  const undo = page.locator('.dock-toast').getByRole('button', { name: 'Undo', exact: true });
  await undo.click();
  assert.deepEqual(await writes(page), ['set', 'set'], 'menu and Undo each write once');
  await seeLayout(page, reordered);

  await grip(page, FLOW).click();
  await page.getByRole('menuitem', { name: 'Full width' }).click();
  await seeLayout(page, { top: ['flow'], a: ['fyi'], b: ['needs', 'loose'] });
  await page.getByRole('menu', { name: `Move ${FLOW}` }).waitFor({ state: 'hidden' });

  await page.locator('.dock-toast').getByRole('button', { name: 'Reset layout' }).click();
  await seeLayout(page, HOME);
  await page.reload();
  await seeLayout(page, HOME);
}

export async function checkPhoneDock(page) {
  const home = await page.evaluate(readLayout);
  const above = async (first, second) => {
    const a = await region(page, first).boundingBox();
    const b = await region(page, second).boundingBox();
    assert.ok(a && b && a.y < b.y, `${first} appears above ${second}`);
  };
  await above('Needs you', 'FYI');
  await grip(page, 'FYI').tap();
  await page.getByRole('menuitem', { name: 'Move to top' }).tap();
  const moved = { ...home, top: ['fyi', ...home.top.filter(id => id !== 'fyi')] };
  await seeLayout(page, moved);
  await above('FYI', 'Needs you');
  assert.deepEqual(await writes(page), ['set']);
  await page.getByRole('menu').waitFor({ state: 'hidden' });

  await page.locator('.dock-toast').getByRole('button', { name: 'Undo' }).tap();
  await seeLayout(page, home);
  await above('Needs you', 'FYI');
  assert.deepEqual(await writes(page), ['set', 'set']);

  await grip(page, 'FYI').tap();
  await page.getByRole('menuitem', { name: 'Move to top' }).tap();
  await seeLayout(page, moved);
  await page.reload();
  await seeLayout(page, moved);
  assert.deepEqual(await writes(page), [], 'reloading a saved phone layout writes nothing');

  await page.locator('.head').getByRole('button', { name: 'Reset layout' }).tap();
  await seeLayout(page, home);
  await above('Needs you', 'FYI');
  assert.deepEqual(await writes(page), ['remove']);
}
