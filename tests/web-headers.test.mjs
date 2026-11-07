// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

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

test('the enforced CSP forbids framing; the full policy is report-only and names what the app loads', () => {
  const enforced = header('Content-Security-Policy') ?? '';
  assert.match(enforced, /frame-ancestors 'none'/);
  assert.match(enforced, /object-src 'none'/);
  const draft = header('Content-Security-Policy-Report-Only') ?? '';
  for (const part of ["default-src 'self'", 'connect-src', 'worker-src', 'frame-src', 'img-src'])
    assert.ok(draft.includes(part), `report-only policy has ${part}`);
  assert.doesNotMatch(draft, /script-src[^;]*'unsafe-inline'/, 'no blanket inline scripts');
  assert.doesNotMatch(draft, /script-src[^;]*'unsafe-eval'/);
});

test('the inline theme script in index.html is allowed by its hash in the policy', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  assert.equal(scripts.length, 1, 'index.html has exactly one inline script');
  const hash = createHash('sha256').update(scripts[0]).digest('base64');
  assert.ok(
    (header('Content-Security-Policy-Report-Only') ?? '').includes(`'sha256-${hash}'`),
    'update the sha256 in netlify.toml after editing the inline script',
  );
});

test('the redirects that serve the app still follow the headers block', () => {
  assert.ok(toml.indexOf('[[headers]]') < toml.indexOf('[[redirects]]'));
  assert.match(toml, /from = "\/\*"[\s\S]*to = "\/index.html"/);
});
