// SPDX-License-Identifier: Apache-2.0
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cpus, platform, release } from 'node:os';
import { chromium } from 'playwright';
import { ShotError } from './options.mjs';
import { hiddenHero } from './landing-hidden.mjs';
import { checkHeroPixels } from './landing-pixels.mjs';

/** Public-page evidence uses a fresh anonymous context, without loading bot credentials. */
export async function captureLanding(config) {
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 1500, height: config.height },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    page.on('dialog', dialog => void dialog.accept());
    const errors = [];
    let navigations = 0;
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) navigations++;
    });
    page.on('pageerror', () => errors.push('runtime error'));
    await mkdir(config.out, { recursive: true, mode: 0o700 });
    const shots = [];
    for (const theme of config.themes)
      for (const width of config.widths) {
        await page.setViewportSize({ width, height: config.height });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
        await page.goto(config.base, { waitUntil: 'domcontentloaded' });
        await page.evaluate(theme => localStorage.setItem('forge-theme', theme), theme);
        await page.reload();
        await page.getByRole('heading', { name: 'Hand it off. Watch it land.' }).waitFor();
        await page.evaluate(() => document.fonts.ready);
        if (await page.evaluate(() => Boolean(window.Clerk?.session)))
          throw new ShotError('Landing capture must be signed out.');
        const name = `landing-${width}-${theme}`;
        await page.screenshot({ path: join(config.out, `${name}.png`), scale: 'css' });
        await page.screenshot({ path: join(config.out, `${name}-full.png`), fullPage: true, scale: 'css' });
        const geometry = await page.evaluate(() => ({
          viewport: innerWidth,
          content: document.documentElement.scrollWidth,
        }));
        if (geometry.content > geometry.viewport) throw new ShotError('Landing overflows the viewport.');
        shots.push({ width, theme, viewport: `${name}.png`, fullPage: `${name}-full.png` });
        console.log(`Saved ${name}.png`);
      }
    await page.setViewportSize({ width: 1500, height: config.height });
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'no-preference' });
    await page.evaluate(() => localStorage.setItem('forge-theme', 'dark'));
    await page.reload();
    await page.getByRole('heading', { name: 'Hand it off. Watch it land.' }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    const started = Date.now(),
      frames = [];
    for (let index = 0; index < 4; index++) {
      const due = started + index * (10_000 / 3);
      await page.waitForTimeout(Math.max(0, due - Date.now()));
      const file = `hero-frame-${index + 1}.png`;
      await page.locator('.fx-hero').screenshot({ path: join(config.out, file), scale: 'css' });
      frames.push({ file, elapsedMs: Date.now() - started });
    }
    // Compose real captured frames in-browser (no image editor dependency).
    const strip = await context.newPage();
    const { readFile } = await import('node:fs/promises');
    const urls = await Promise.all(
      frames.map(
        async frame =>
          `data:image/png;base64,${(await readFile(join(config.out, frame.file))).toString('base64')}`,
      ),
    );
    await strip.setContent(
      `<style>body{margin:0;background:#0b0e13;color:#a3adbb;font:12px system-ui}.frame{width:750px}img{display:block;width:750px}p{margin:0;padding:6px 12px}main{display:grid;grid-template-columns:repeat(4,750px)}</style><main>${urls.map((url, i) => `<div class="frame"><p>+${(frames[i].elapsedMs / 1000).toFixed(1)} s</p><img src="${url}"></div>`).join('')}</main>`,
    );
    await strip.setViewportSize({ width: 3000, height: 400 });
    await strip.locator('main').screenshot({ path: join(config.out, 'hero-strip.png'), scale: 'css' });
    await strip.close();
    await page.bringToFront();
    const system = await browser.newBrowserCDPSession();
    const rendererTime = async () =>
      (await system.send('SystemInfo.getProcessInfo')).processInfo
        .filter(p => p.type === 'renderer')
        .reduce((sum, p) => sum + p.cpuTime, 0);
    const devtools = await context.newCDPSession(page);
    await devtools.send('Performance.enable');
    const taskTime = async () =>
      (await devtools.send('Performance.getMetrics')).metrics.find(m => m.name === 'TaskDuration').value;
    async function sample(label) {
      const navigationStart = navigations;
      const cpuStart = await rendererTime(),
        taskStart = await taskTime(),
        start = performance.now();
      await page.waitForTimeout(30_000);
      const seconds = (performance.now() - start) / 1000;
      const cpuEnd = await rendererTime(),
        taskEnd = await taskTime();
      if (navigations !== navigationStart || taskEnd < taskStart || cpuEnd < cpuStart)
        throw new ShotError('Page reloaded during CPU measurement; freeze source watching and retry.');
      return {
        label,
        seconds,
        rendererPercentOneCore: ((cpuEnd - cpuStart) / seconds) * 100,
        mainThreadPercentOneCore: ((taskEnd - taskStart) / seconds) * 100,
      };
    }
    await page.waitForTimeout(2000);
    const animated = await sample('animated idle, 1500px, DPR 2, 40fps cap');
    console.log(
      `Animated idle CPU: ${animated.rendererPercentOneCore.toFixed(2)}% renderer / ${animated.mainThreadPercentOneCore.toFixed(2)}% main thread`,
    );
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(1000);
    const still = await sample('reduced-motion still, same page');
    const cpu = {
      machine: cpus()[0]?.model,
      platform: `${platform()} ${release()}`,
      browser: browser.version(),
      dpr: 2,
      mode: 'headed Chromium on this Mac',
      animated,
      still,
      heroIncrementalRendererPercentOneCore: animated.rendererPercentOneCore - still.rendererPercentOneCore,
    };
    await writeFile(join(config.out, 'cpu.json'), JSON.stringify(cpu, null, 2) + '\n');
    const pixels = () => page.locator('.fx-alive').evaluate(canvas => canvas.toDataURL());
    const checks = {};
    let first = await pixels();
    await page.waitForTimeout(350);
    checks.reducedMotionStill = first === (await pixels());
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForTimeout(350);
    first = await pixels();
    await page.waitForTimeout(350);
    checks.motionResumes = first !== (await pixels());
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(350);
    first = await pixels();
    await page.waitForTimeout(350);
    checks.offscreenStill = first === (await pixels());
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForTimeout(350);
    Object.assign(checks, await hiddenHero(config.base));
    await page.bringToFront();
    await page.evaluate(() => {
      window.__s5Paints = 0;
      const original = CanvasRenderingContext2D.prototype.clearRect;
      CanvasRenderingContext2D.prototype.clearRect = function (...args) {
        if (this.canvas.matches('.fx-alive') && args[0] === 0 && args[3] === 10) window.__s5Paints++;
        return original.apply(this, args);
      };
    });
    const capStart = Date.now();
    await page.waitForTimeout(1500);
    checks.paintedFrames = await page.evaluate(() => window.__s5Paints);
    checks.observedFps = checks.paintedFrames / ((Date.now() - capStart) / 1000);
    checks.frameCap = checks.observedFps <= 41 && checks.observedFps > 0;
    const development = await page.evaluate(() =>
      Boolean(document.querySelector('script[src*="/@vite/client"]')),
    );
    checks.retainedPixels = development
      ? await checkHeroPixels(page)
      : { passed: null, reason: 'Pixel comparison needs the local dev source modules.' };
    await writeFile(join(config.out, 'motion-checks.json'), JSON.stringify(checks, null, 2) + '\n');
    if (
      !checks.reducedMotionStill ||
      !checks.motionResumes ||
      !checks.offscreenStill ||
      !checks.backgroundTabHidden ||
      !checks.backgroundTabStill ||
      !checks.frameCap ||
      checks.retainedPixels.passed === false
    )
      throw new ShotError('Landing motion lifecycle check failed.');
    if (errors.length) throw new ShotError('Landing raised a JavaScript runtime error.');
    await writeFile(
      join(config.out, 'manifest.json'),
      JSON.stringify(
        {
          base: config.base,
          signedIn: false,
          capturedAt: new Date().toISOString(),
          shots,
          frames,
          cpu,
          checks,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(`Still CPU: ${still.rendererPercentOneCore.toFixed(2)}%; saved hero-strip.png and cpu.json`);
  } finally {
    await browser.close();
  }
}
