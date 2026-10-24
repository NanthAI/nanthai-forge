// SPDX-License-Identifier: Apache-2.0
// Capture the application loader before its application module arrives; no backend or identity is mocked.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const base = process.argv[2] ?? 'http://127.0.0.1:5177';
const out = resolve(
  process.argv[3] ?? fileURLToPath(new URL('../private-artifacts/ui/loader/', import.meta.url)),
);
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1120, height: 200 }, colorScheme: 'dark' });
  await page.route(/\/src\/Hosted\.tsx(?:\?|$)/, route => route.abort());
  {
    await page.goto(base);
    await page.locator('.fx-loading-mark').waitFor();
    await page.evaluate(() => {
      const root = document.querySelector('#root'),
        original = document.querySelector('.fx-app-loader');
      root.replaceChildren();
      root.style.cssText = 'display:flex;width:1120px;height:200px';
      for (let index = 0; index < 7; index++) {
        const frame = original.cloneNode(true);
        frame.style.cssText = 'min-height:200px;width:160px;position:relative;';
        for (const node of frame.querySelectorAll('[id]')) node.id += `-${index}`;
        for (const node of frame.querySelectorAll('[clip-path]'))
          node.setAttribute('clip-path', node.getAttribute('clip-path').replace(')', `-${index})`));
        const time = document.createElement('span');
        time.textContent = `${Math.round((index * 2200) / 6)} ms`;
        time.style.cssText = 'position:absolute;bottom:16px;font:12px monospace;opacity:.65';
        frame.append(time);
        root.append(frame);
        for (const animation of frame.getAnimations({ subtree: true })) {
          animation.pause();
          animation.currentTime = Math.round((index * 2200) / 6);
        }
      }
    });
    await page.screenshot({ path: join(out, 'loader-strip.png') });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const active = await page.evaluate(
      () => document.getAnimations().filter(animation => animation.playState === 'running').length,
    );
    if (active) throw Error('Reduced motion left an active loader animation.');
    await page.screenshot({ path: join(out, 'loader-reduced-motion.png') });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    console.log('Saved loader-strip.png; reduced motion is static.');
  }
} finally {
  await browser.close();
}
