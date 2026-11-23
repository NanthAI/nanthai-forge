// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium, firefox } from 'playwright';

const DESKTOP = { width: 1440, height: 1000 };
export const reflowViewport = zoom => ({ width: DESKTOP.width / zoom, height: DESKTOP.height / zoom });

/** Actual full-page zoom in Chromium and Firefox. WebKit's Playwright API exposes viewport emulation only. */
export async function zoomContext(browser, name, directory, zoom, launchOptions) {
  const locale = 'en-US';
  if (name === 'webkit') {
    const context = await browser.newContext({ locale, viewport: reflowViewport(zoom) });
    return { context, applyZoom: async () => {} };
  }
  const profile = join(directory, `profile-${name}-${zoom}`);
  mkdirSync(profile);
  if (name === 'firefox') {
    // Firefox stores the user-facing default zoom in the profile's content preferences, apart from user.js.
    const db = new DatabaseSync(join(profile, 'content-prefs.sqlite'));
    db.exec(`
      PRAGMA user_version = 6;
      CREATE TABLE groups (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE settings (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE prefs (id INTEGER PRIMARY KEY, groupID INTEGER REFERENCES groups(id),
        settingID INTEGER NOT NULL REFERENCES settings(id), value BLOB, timestamp INTEGER NOT NULL DEFAULT 0);
      INSERT INTO settings VALUES (1, 'browser.content.full-zoom');
    `);
    db.prepare('INSERT INTO prefs (settingID, value) VALUES (1, ?)').run(zoom);
    db.close();
    const context = await firefox.launchPersistentContext(profile, {
      locale,
      viewport: DESKTOP,
      firefoxUserPrefs: { 'zoom.maxPercent': 500 },
    });
    return { context, applyZoom: async () => {} };
  }

  // Chrome's extension API applies the same tab zoom as its browser menu. The worker has no content script.
  const extension = join(directory, `chromium-zoom-${zoom}`);
  mkdirSync(extension);
  writeFileSync(
    join(extension, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'Forge fixture zoom',
      version: '1.0.0',
      background: { service_worker: 'zoom.js' },
      permissions: ['tabs'],
    }),
  );
  writeFileSync(join(extension, 'zoom.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
  const context = await chromium.launchPersistentContext(profile, {
    ...launchOptions,
    locale,
    viewport: DESKTOP,
    channel: 'chromium',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  return {
    context,
    async applyZoom(page) {
      const worker =
        context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 5000 }));
      await worker.evaluate(
        async ({ url, factor }) => {
          const [tab] = (await chrome.tabs.query({})).filter(tab => tab.url === url);
          await chrome.tabs.setZoom(tab.id, factor);
        },
        { url: page.url(), factor: zoom },
      );
    },
  };
}
