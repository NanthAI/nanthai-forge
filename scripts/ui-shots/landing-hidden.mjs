// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { chromium } from 'playwright';

/** Playwright forces focus in its normal contexts. Use a fresh native default context
 * without those overrides to exercise the actual document.hidden browser event. */
export async function hiddenHero(base) {
  const directory = await mkdtemp(join(tmpdir(), 'forge-hero-visibility-'));
  const process = spawn(
    chromium.executablePath(),
    [
      '--remote-debugging-port=0',
      `--user-data-dir=${directory}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  let browser, system;
  try {
    let port;
    for (let retry = 0; retry < 100; retry++) {
      try {
        port = (await readFile(join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
        break;
      } catch {
        await setTimeout(100);
      }
    }
    if (!port) throw new Error('Chromium visibility check did not start.');
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
    const context = browser.contexts()[0],
      page = context.pages()[0];
    await page.setViewportSize({ width: 1500, height: 1000 });
    await page.goto(base);
    await page.getByRole('heading', { name: 'Hand it off. Watch it land.' }).waitFor();
    await page.waitForTimeout(350);
    system = await browser.newBrowserCDPSession();
    const devtools = await context.newCDPSession(page);
    const { targetInfo } = await devtools.send('Target.getTargetInfo');
    const { windowId } = await system.send('Browser.getWindowForTarget', { targetId: targetInfo.targetId });
    const { targetId } = await system.send('Target.createTarget', {
      url: 'about:blank',
      newWindow: false,
      background: false,
      windowId,
    });
    await system.send('Target.activateTarget', { targetId });
    await page.waitForTimeout(350);
    const hidden = await page.evaluate(() => document.hidden);
    const first = await page.locator('.fx-alive').evaluate(canvas => canvas.toDataURL());
    await page.waitForTimeout(350);
    const unchanged = first === (await page.locator('.fx-alive').evaluate(canvas => canvas.toDataURL()));
    return { backgroundTabHidden: hidden, backgroundTabStill: unchanged };
  } finally {
    await system?.send('Browser.close').catch(() => {});
    await browser?.close().catch(() => {});
    process.kill();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
