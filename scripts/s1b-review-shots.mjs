// SPDX-License-Identifier: Apache-2.0
// Run scripts/s1b-review-preview.mjs first. Local synthetic data, no hosted connection.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const out = resolve(
  process.argv[2] ?? fileURLToPath(new URL('../private-artifacts/ui/s1b/', import.meta.url)),
);
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const findings = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', error => findings.push({ error: error.message }));
  page.on('console', message => {
    if (message.type() === 'error') findings.push({ error: message.text() });
  });
  for (const [width, theme] of [
    [1500, 'dark'],
    [390, 'light'],
  ]) {
    await page.setViewportSize({ width, height: 980 });
    for (const state of ['ready', 'requested', 'waiting', 'accepted', 'rejected']) {
      await page.goto(`http://127.0.0.1:5193/s1b.html?state=${state}&theme=${theme}`, {
        waitUntil: 'domcontentloaded',
        timeout: 120000,
      });
      await page.locator('.fx-decide').waitFor({ timeout: 120000 });
      const filename = `review-${state}-${width}-${theme}.png`;
      const metrics = await page.evaluate(() => ({
        width: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        status: document.querySelector('.fx-decide-go [role="status"]')?.textContent,
        headerStatus: document.querySelector('.fx-review-head .fx-st')?.textContent,
        titleHeight: document.querySelector('.fx-review-head h1')?.clientHeight,
        titleOverflow: getComputedStyle(document.querySelector('.fx-review-head h1')).overflowY,
        titleMaxHeight: getComputedStyle(document.querySelector('.fx-review-head h1')).maxHeight,
        titleScrollHeight: document.querySelector('.fx-review-head h1')?.scrollHeight,
        buttons: [...document.querySelectorAll('.fx-decide button')].map(b => ({
          text: b.textContent,
          disabled: b.disabled,
        })),
      }));
      const expected = {
        ready: 'Ready',
        requested: 'Requested',
        waiting: 'Waiting for Maya’s MacBook Pro',
        accepted: 'Accepted',
        rejected: 'Not accepted',
      }[state];
      if (metrics.headerStatus !== expected)
        throw Error(`Header state mismatch: ${state}: ${metrics.headerStatus}`);
      if (metrics.titleOverflow !== 'visible' || metrics.titleMaxHeight !== 'none')
        throw Error(`Review title is clipped: ${JSON.stringify(metrics)}`);
      if (state === 'rejected' && !metrics.buttons.some(button => button.text === 'Re-check on latest main'))
        throw Error('Overlap rejection has no re-check action');
      findings.push({ filename, ...metrics });
      await page.screenshot({ path: join(out, filename), fullPage: true });
      if (state === 'rejected') {
        await page.getByRole('button', { name: 'Re-check on latest main', exact: true }).click();
        await page
          .getByText('Re-check requested · Waiting for Maya’s MacBook Pro', { exact: true })
          .waitFor();
        const calls = await page.evaluate(() => globalThis.__forgeRequests);
        if (calls.length !== 1 || calls[0].recheck !== true || calls[0].channel !== 'recheck')
          throw Error('Recovery did not request recomposition/check');
      }
    }
  }
} finally {
  await browser.close();
}
await writeFile(
  join(out, 'evidence.json'),
  JSON.stringify(
    { kind: 'local synthetic real HostedReview component; no live sign-in or owner mutation', findings },
    null,
    2,
  ),
);
if (findings.some(f => f.error || f.scrollWidth > f.width))
  throw Error('Review evidence contains errors or horizontal overflow.');
console.log(`Saved ${findings.length} Review captures to ${out}`);
