// SPDX-License-Identifier: Apache-2.0
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { ShotError } from './options.mjs';
import { hiddenHero } from './landing-hidden.mjs';

const heading = 'Git was built for people. Forge is built for agents.';
const ticks = page => page.evaluate(() => window.__forgeHero?.ticks ?? 0);
const metrics = async devtools =>
  Object.fromEntries((await devtools.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));

/** Public-page evidence: still screenshots per width and theme, keyboard focus, no-JS, a hero strip, then the motion
 * lifecycle (loop, calm-down, off screen, hidden tab, reduced motion, charts once) and the page's cost in a fresh
 * anonymous context. Point --base at a built preview: dev-server modules distort bytes and frame time. */
export async function captureLanding(config) {
  const browser = await chromium.launch();
  try {
    await mkdir(config.out, { recursive: true, mode: 0o700 });
    const shots = [];
    const context = await browser.newContext({
      viewport: { width: 1500, height: config.height },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    const errors = [],
      foreign = [];
    page.on('pageerror', () => errors.push('runtime error'));
    page.on('request', request => {
      if (new URL(request.url()).origin !== new URL(config.base).origin)
        foreign.push(new URL(request.url()).origin);
    });
    for (const theme of config.themes)
      for (const width of config.widths) {
        await page.setViewportSize({ width, height: width < 600 ? 844 : config.height });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
        await page.goto(config.base);
        await page.getByRole('heading', { name: heading }).waitFor();
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(600);
        const name = `landing-${width}-${theme}`;
        await page.screenshot({ path: join(config.out, `${name}.png`), scale: 'css' });
        await page.screenshot({ path: join(config.out, `${name}-full.png`), fullPage: true, scale: 'css' });
        const geometry = await page.evaluate(() => ({
          viewport: innerWidth,
          content: document.documentElement.scrollWidth,
        }));
        if (geometry.content > geometry.viewport)
          throw new ShotError(`Landing overflows the viewport at ${width}px.`);
        shots.push({ width, theme, viewport: `${name}.png`, fullPage: `${name}-full.png` });
        console.log(`Saved ${name}.png`);
      }

    // Keyboard: the first stops are the skip link, the brand, the nav and the key, each with a visible focus ring.
    await page.setViewportSize({ width: 1500, height: config.height });
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.goto(config.base);
    await page.getByRole('heading', { name: heading }).waitFor();
    const order = [];
    for (let i = 0; i < 7; i++) {
      await page.keyboard.press('Tab');
      order.push(await page.evaluate(() => document.activeElement?.textContent?.trim().slice(0, 40) ?? ''));
    }
    await page.screenshot({ path: join(config.out, 'landing-keyboard-key.png'), scale: 'css' });
    shots.push({ keyboard: order, file: 'landing-keyboard-key.png' });

    // Without JavaScript every section, figure and link is still there.
    const nojs = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: 1500, height: config.height },
    });
    const plain = await nojs.newPage();
    await plain.goto(config.base);
    await plain.screenshot({ path: join(config.out, 'landing-nojs-full.png'), fullPage: true, scale: 'css' });
    const nojsRace = await plain.locator('[data-clock]').textContent();
    await nojs.close();

    // Cost: a cold load with network accounting, then frame time and memory while the hero animates.
    const cold = await browser.newContext({ viewport: { width: 1500, height: config.height } });
    const cp = await cold.newPage();
    const devtools = await cold.newCDPSession(cp);
    await devtools.send('Network.enable');
    await devtools.send('Performance.enable');
    const responses = new Map(),
      bodies = [];
    devtools.on('Network.responseReceived', e => responses.set(e.requestId, e.response));
    devtools.on('Network.loadingFinished', e => {
      const response = responses.get(e.requestId);
      if (response)
        bodies.push(
          devtools
            .send('Network.getResponseBody', { requestId: e.requestId })
            .then(b => Buffer.from(b.body, b.base64Encoded ? 'base64' : 'utf8'))
            .catch(() => Buffer.alloc(0))
            .then(bytes => ({
              url: new URL(response.url).pathname,
              type: response.mimeType,
              bytes: bytes.length,
              gzipBytes: gzipSync(bytes).length,
            })),
        );
    });
    await cp.goto(config.base, { waitUntil: 'load' });
    await cp.waitForFunction(() => window.__forgeHero?.running === true, null, { timeout: 10_000 });
    const paint = await cp.evaluate(() =>
      Object.fromEntries(performance.getEntriesByType('paint').map(e => [e.name, Math.round(e.startTime)])),
    );
    const loaded = await Promise.all(bodies);
    const requestsBefore = loaded.length;
    const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);
    const js = loaded.filter(r => /javascript/.test(r.type));
    const startMetrics = await metrics(devtools),
      startTicks = await ticks(cp);
    await cp.waitForTimeout(10_000);
    const endMetrics = await metrics(devtools),
      endTicks = await ticks(cp);
    const frames = endTicks - startTicks;
    const animating = {
      seconds: 10,
      framesDrawn: frames,
      fps: frames / 10,
      mainThreadMsPerFrame: ((endMetrics.TaskDuration - startMetrics.TaskDuration) * 1000) / frames,
      scriptMsPerFrame: ((endMetrics.ScriptDuration - startMetrics.ScriptDuration) * 1000) / frames,
      layoutMsPerFrame: ((endMetrics.LayoutDuration - startMetrics.LayoutDuration) * 1000) / frames,
      heapUsedBytes: endMetrics.JSHeapUsedSize,
      heapGrowthBytes: endMetrics.JSHeapUsedSize - startMetrics.JSHeapUsedSize,
      requestsWhileAnimating: (await Promise.all(bodies)).length - requestsBefore,
    };
    const cost = {
      firstPaintMs: paint['first-paint'],
      firstContentfulPaintMs: paint['first-contentful-paint'],
      requests: loaded.length,
      bytes: sum(loaded, 'bytes'),
      gzipBytes: sum(loaded, 'gzipBytes'),
      jsBytes: sum(js, 'bytes'),
      jsGzipBytes: sum(js, 'gzipBytes'),
      files: loaded,
      animating,
    };
    console.log(
      `Cold load: ${cost.gzipBytes} B gzip (${cost.jsGzipBytes} B JS), FCP ${cost.firstContentfulPaintMs} ms; ${animating.mainThreadMsPerFrame.toFixed(2)} ms main thread per frame`,
    );

    // Motion lifecycle, read from the page's own counters.
    const checks = {};
    const advancing = async () => {
      const a = await ticks(cp);
      await cp.waitForTimeout(700);
      return (await ticks(cp)) > a;
    };
    checks.loops = await advancing();
    await cp.evaluate(() => document.getElementById('cost')?.scrollIntoView());
    await cp.waitForTimeout(700);
    checks.offscreenStops = !(await advancing());
    checks.chartsDrawn = await cp.evaluate(() => document.getElementById('cost')?.classList.contains('seen'));
    await cp.evaluate(() => document.getElementById('speed')?.scrollIntoView());
    await cp.waitForFunction(
      () =>
        window.__forgeLanding?.race === false &&
        document.querySelector('[data-clock]')?.textContent === '19:42',
      null,
      { timeout: 20_000 },
    );
    await cp.evaluate(() => scrollTo(0, 0));
    await cp.evaluate(() => document.getElementById('speed')?.scrollIntoView());
    await cp.waitForTimeout(400);
    checks.raceRestsAfterOnce = await cp.evaluate(
      () =>
        window.__forgeLanding?.race === false &&
        document.querySelector('[data-clock]')?.textContent === '19:42',
    );
    await cp.evaluate(() => scrollTo(0, 0));
    await cp.waitForTimeout(400);
    checks.resumesOnScreen = await advancing();
    // Calm-down: after 60 s without input it keeps drawing, at about 15 frames a second.
    const calmStart = await ticks(cp);
    await cp.waitForTimeout(62_000);
    const calm = await cp.evaluate(() => window.__forgeHero?.calm);
    const c0 = await ticks(cp);
    await cp.waitForTimeout(4000);
    checks.calmFps = ((await ticks(cp)) - c0) / 4;
    checks.calmKeepsRunning = calm === 'slow' && checks.calmFps > 8 && checks.calmFps < 20 && c0 > calmStart;
    await cp.mouse.move(400, 300);
    await cp.waitForTimeout(1000);
    checks.awakeAfterInput = (await cp.evaluate(() => window.__forgeHero?.calm)) === 'awake';
    await cp.emulateMedia({ reducedMotion: 'reduce' });
    await cp.waitForTimeout(600);
    checks.reducedMotionStill = !(await advancing());
    checks.reducedMotionDrawn = await cp.evaluate(() =>
      document.querySelector('.hero')?.hasAttribute('data-on'),
    );
    await cp.screenshot({ path: join(config.out, 'landing-reduced-motion-hero.png'), scale: 'css' });
    await cp.emulateMedia({ reducedMotion: 'no-preference' });
    await cp.waitForTimeout(600);
    checks.motionResumes = await advancing();
    const strip = [];
    for (let i = 0; i < 4; i++) {
      const file = `hero-frame-${i + 1}.png`;
      await cp.locator('.hero').screenshot({ path: join(config.out, file), scale: 'css' });
      strip.push(file);
      await cp.waitForTimeout(3200);
    }
    Object.assign(checks, await hiddenHero(config.base, heading));
    checks.noForeignRequests = foreign.length === 0;
    checks.nojsRaceEndState = nojsRace === '19:42';
    await cold.close();
    await writeFile(join(config.out, 'motion-checks.json'), JSON.stringify(checks, null, 2) + '\n');
    await writeFile(join(config.out, 'cost.json'), JSON.stringify(cost, null, 2) + '\n');
    const failed = Object.entries(checks).filter(([k, v]) => v === false && k !== 'calmFps');
    if (failed.length)
      throw new ShotError(`Landing motion lifecycle check failed: ${failed.map(([k]) => k).join(', ')}`);
    if (errors.length) throw new ShotError('Landing raised a JavaScript runtime error.');
    await writeFile(
      join(config.out, 'manifest.json'),
      JSON.stringify(
        {
          base: config.base,
          signedIn: false,
          capturedAt: new Date().toISOString(),
          shots,
          strip,
          cost,
          checks,
        },
        null,
        2,
      ) + '\n',
    );
    console.log('Saved manifest.json, motion-checks.json and cost.json');
  } finally {
    await browser.close();
  }
}
