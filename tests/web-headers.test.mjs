// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The hosted web app's response headers live in netlify.toml (review S-13). */
const toml = readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8');
const block = toml.split('[[headers]]')[1]?.split('[[redirects]]')[0] ?? '';
const header = name => new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, 'm').exec(block)?.[1];

test('every page is sent with frame protection, nosniff, no referrer and HSTS', () => {
  assert.match(block, /for = "\/\*"/);
  assert.equal(header('X-Frame-Options'), 'DENY');
  assert.equal(header('X-Content-Type-Options'), 'nosniff');
  assert.equal(header('Referrer-Policy'), 'no-referrer');
  assert.match(header('Strict-Transport-Security') ?? '', /^max-age=\d{7,}/);
  assert.match(header('Permissions-Policy') ?? '', /camera=\(\)/);
});

test('the full CSP is enforced, forbids framing and names what the app loads', () => {
  const enforced = header('Content-Security-Policy') ?? '';
  assert.equal(header('Content-Security-Policy-Report-Only'), undefined, 'no report-only draft is left');
  for (const part of [
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "default-src 'self'",
    'connect-src',
    'worker-src',
    'frame-src',
    'img-src',
  ])
    assert.ok(enforced.includes(part), `enforced policy has ${part}`);
  assert.doesNotMatch(enforced, /script-src[^;]*'unsafe-inline'/, 'no blanket inline scripts');
  assert.doesNotMatch(enforced, /script-src[^;]*'unsafe-eval'/);
});

test('the web entry turns off Zod string evaluation before anything else runs', async () => {
  const main = readFileSync(new URL('../web/src/main.tsx', import.meta.url), 'utf8');
  const firstImport = /^import [^\n]*$/m.exec(main)?.[0];
  assert.equal(firstImport, "import './zod-jitless';", 'main.tsx imports ./zod-jitless first');
  const jitless = readFileSync(new URL('../web/src/zod-jitless.ts', import.meta.url), 'utf8');
  assert.match(jitless, /__zod_globalConfig = \{ \.\.\.scope\.__zod_globalConfig, jitless: true \}/);
  // The pinned Zod must pick up a config object set before it loads (else it probes Function('')).
  const probe = [
    'globalThis.__zod_globalConfig = { jitless: true };',
    "const { z } = await import('zod');",
    'let evaluated = 0;',
    'const real = globalThis.Function;',
    'globalThis.Function = new Proxy(real, { apply: (t, s, a) => (evaluated++, Reflect.apply(t, s, a)), construct: (t, a) => (evaluated++, Reflect.construct(t, a)) });',
    'const schema = z.object({ a: z.string(), b: z.number() });',
    "for (let i = 0; i < 3; i++) schema.parse({ a: 'x', b: i });",
    'globalThis.Function = real;',
    'console.log(JSON.stringify({ jitless: z.config().jitless, evaluated }));',
  ].join('\n');
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
  });
  assert.deepEqual(JSON.parse(out), { jitless: true, evaluated: 0 });
});

test('the inline theme script in index.html is allowed by its hash in the policy', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  assert.equal(scripts.length, 1, 'index.html has exactly one inline script');
  const hash = createHash('sha256').update(scripts[0]).digest('base64');
  assert.ok(
    (header('Content-Security-Policy') ?? '').includes(`'sha256-${hash}'`),
    'update the sha256 in netlify.toml after editing the inline script',
  );
});

test('the redirects that serve the app still follow the headers block', () => {
  assert.ok(toml.indexOf('[[headers]]') < toml.indexOf('[[redirects]]'));
  assert.match(toml, /from = "\/\*"[\s\S]*to = "\/index.html"/);
});
