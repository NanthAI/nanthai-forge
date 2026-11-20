// SPDX-License-Identifier: Apache-2.0
// A reload with a delayed sign-in (Item 31328be4, owner dogfood 2026-11-17): the real App is mounted with sign-in held
// loading. While it is unresolved nothing renders and no read is sent; the first paint is the view the resolved
// access gets (a signed-in project page, a redirect to sign-in, a signed-out front page), never a different-access
// view that is then swapped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));

test('a reload with sign-in still loading renders nothing and reads nothing; the resolved access then paints its own view once', async t => {
  const executablePath = process.env.FORGE_UI_BROWSER || chromium.executablePath();
  if (!existsSync(executablePath)) return t.skip('A test browser is not installed; set FORGE_UI_BROWSER.');
  const temp = mkdtempSync(join(tmpdir(), 'forge-delayed-auth-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const out = join(temp, 'out');
  const html = join(temp, 'fixture.html');
  const convexShim = join(temp, 'convex-react.ts');
  const authShim = join(temp, 'convex-auth-react.tsx');
  writeFileSync(
    convexShim,
    `import { useSyncExternalStore } from 'react';
    import { getFunctionName } from 'convex/server';
    export * from ${JSON.stringify(join(root, 'node_modules/convex/dist/esm/react/index.js'))};
    const listeners = new Set<() => void>();
    const w = window as any;
    w.auth = { isLoading: true, isAuthenticated: false };
    w.authReads = 0;
    w.reads = [];
    // The test resolves sign-in by hand, as a slow token check would.
    w.resolveAuth = (isAuthenticated: boolean) => {
      w.auth = { isLoading: false, isAuthenticated };
      listeners.forEach(listener => listener());
    };
    const subscribe = (listener: () => void) => (listeners.add(listener), () => listeners.delete(listener));
    const client = {
      query: async () => null,
      mutation: async () => null,
      action: async () => null,
      setAuth() {},
      clearAuth() {},
      close: async () => {},
      connectionState: () => ({ isWebSocketConnected: true, hasEverConnected: true }),
    };
    export class ConvexReactClient { constructor() { return client as any; } }
    export const useConvex = () => client;
    export const useConvexAuth = () => (w.authReads++, useSyncExternalStore(subscribe, () => w.auth));
    export const useQuery = (reference: any, args: unknown) => {
      if (args !== 'skip') w.reads.push(getFunctionName(reference));
      return undefined;
    };
    export const usePaginatedQuery = (reference: any, args: unknown) => {
      if (args !== 'skip') w.reads.push(getFunctionName(reference));
      return { results: [], status: 'LoadingFirstPage', isLoading: true, loadMore() {} };
    };
    export const useQueries = (queries: Record<string, any>) => {
      for (const { query } of Object.values(queries)) w.reads.push(getFunctionName(query));
      return {};
    };
    export const useMutation = () => async () => null;
    export const useAction = () => async () => null;
    export const useConvexConnectionState = () => ({ isWebSocketConnected: true, hasEverConnected: true });`,
  );
  writeFileSync(
    authShim,
    `import { createElement, Fragment } from 'react';
    export const ConvexAuthProvider = ({ children }: any) => createElement(Fragment, null, children);
    export const useAuthActions = () => ({ signIn: async () => ({ signingIn: false }), signOut: async () => {} });`,
  );
  // The sign-in page's own hooks come from the auth library and need its provider; the test gives them inert ones.
  const methodsShim = join(temp, 'convex-auth-methods.ts');
  writeFileSync(
    methodsShim,
    `export const useOauth = () => ({ flowError: null });
    export const useSignInWithGithub = () => ({ signIn: async () => ({ signingIn: false }) });
    export const useAddPasskey = () => ({ pending: false, add: async () => ({}) });
    export const useRemovePasskey = () => ({ pending: false, remove: async () => ({}) });
    export const useSignInWithUsernamePasskey = () => ({ pending: false, signIn: async () => ({ signingIn: false }) });`,
  );
  writeFileSync(
    html,
    '<!doctype html><html lang="en" data-ds><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Forge</title></head><body><main id="root"></main><script type="module" src="./fixture.tsx"></script></body></html>',
  );
  writeFileSync(
    join(temp, 'fixture.tsx'),
    `import React from 'react';
    import { createRoot } from 'react-dom/client';
    import App from ${JSON.stringify(join(root, 'web/src/app/App.tsx'))};
    const host = document.getElementById('root')!;
    // Every change of what is on screen: the sign-in state and address it appeared under, and whether it was empty.
    (window as any).paints = [];
    new MutationObserver(() =>
      (window as any).paints.push({
        loading: (window as any).auth.isLoading,
        empty: host.childElementCount === 0,
        path: location.pathname,
      }),
    ).observe(host, { childList: true, subtree: true });
    createRoot(host).render(<App />);`,
  );
  const { build } = await import('vite');
  await build({
    configFile: join(root, 'web/vite.config.ts'),
    root: temp,
    base: '/',
    envDir: false,
    logLevel: 'error',
    define: { 'import.meta.env.VITE_CONVEX_URL': JSON.stringify('https://forge.test.convex.cloud') },
    resolve: {
      alias: [
        { find: /^convex\/react$/, replacement: convexShim },
        { find: /^@convex-dev\/auth\/react$/, replacement: authShim },
        { find: /^@convex-dev\/auth\/methods\/.*$/, replacement: methodsShim },
        { find: /^react\//, replacement: dirname(require.resolve('react/package.json')) + '/' },
        { find: /^react$/, replacement: dirname(require.resolve('react/package.json')) },
        { find: /^react-dom\//, replacement: dirname(require.resolve('react-dom/package.json')) + '/' },
        { find: /^convex\/server$/, replacement: join(root, 'node_modules/convex/dist/esm/server/index.js') },
      ],
    },
    build: { outDir: out, emptyOutDir: true, rolldownOptions: { input: html } },
  });
  const browser = await chromium.launch({ executablePath });
  t.after(async () => {
    await browser.close();
  });
  const open = async path => {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'forge.test') return route.abort();
      const asset = url.pathname.slice(1);
      const file = join(out, asset);
      const served = asset && existsSync(file) && !file.endsWith('/');
      return route.fulfill({
        contentType: !served
          ? 'text/html'
          : file.endsWith('.js')
            ? 'text/javascript'
            : file.endsWith('.css')
              ? 'text/css'
              : 'application/octet-stream',
        body: readFileSync(served ? file : join(out, 'fixture.html')),
      });
    });
    await page.goto('https://forge.test' + path);
    // The app has rendered at least once and asked for sign-in; it is still loading.
    await page.waitForFunction(() => window.authReads > 0);
    return { page, errors };
  };
  const heldState = page =>
    page.evaluate(() => ({
      empty: document.getElementById('root').childElementCount === 0,
      reads: window.reads.length,
      paints: window.paints.length,
      path: location.pathname,
    }));

  // A Lanes page of a project, reloaded: signed-in access.
  {
    const { page, errors } = await open('/-/sample-owner/parser/lanes');
    assert.deepEqual(
      await heldState(page),
      { empty: true, reads: 0, paints: 0, path: '/-/sample-owner/parser/lanes' },
      'while sign-in loads: nothing on screen, no read sent, the address is untouched',
    );
    await page.evaluate(() => window.resolveAuth(true));
    await page.locator('#root > *').first().waitFor();
    const paints = await page.evaluate(() => window.paints);
    assert.ok(
      paints.every(paint => !paint.loading),
      'nothing was painted while sign-in loaded',
    );
    assert.equal(await page.evaluate(() => location.pathname), '/-/sample-owner/parser/lanes');
    assert.deepEqual(errors, []);
    await page.close();
  }

  // The same page for a visitor who turns out to be signed out: no project view appears first, only the sign-in.
  {
    const { page, errors } = await open('/-/sample-owner/parser/lanes');
    assert.equal((await heldState(page)).empty, true, 'while sign-in loads: nothing on screen');
    await page.evaluate(() => window.resolveAuth(false));
    await page.waitForFunction(() => location.pathname.endsWith('/signin'));
    await page.locator('#root > *').first().waitFor();
    const paints = await page.evaluate(() => window.paints);
    assert.ok(paints.length > 0);
    assert.ok(
      paints.every(paint => !paint.loading && !paint.path.endsWith('/lanes')),
      'no project view painted before the redirect to sign-in',
    );
    assert.deepEqual(errors, []);
    await page.close();
  }

  // A public front page for a signed-out visitor appears only after sign-in has resolved too.
  {
    const { page, errors } = await open('/-/sample-owner/parser');
    assert.deepEqual((await heldState(page)).empty, true);
    assert.equal((await heldState(page)).reads, 0);
    await page.evaluate(() => window.resolveAuth(false));
    await page.locator('#root > *').first().waitFor();
    const paints = await page.evaluate(() => window.paints);
    assert.ok(
      paints.every(paint => !paint.loading),
      'the signed-out front page is not painted while sign-in loads',
    );
    assert.deepEqual(errors, []);
    await page.close();
  }
});
