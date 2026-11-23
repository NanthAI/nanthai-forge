// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** Security headers for every response of the site (review S-13): frame protection, MIME sniffing, referrer rules and
 * the full Content-Security-Policy are enforced. A signed-in smoke test of the dev site with this policy enforced
 * showed no violations once Zod runs jitless (web/src/zod-jitless.ts). The inline script hashes must match the one
 * inline script in web/app.html (the app's theme) and in web/index.html (the public page's theme and signed-in
 * redirect); tests/web-headers.test.mjs checks both.
 *
 * One source for both halves of the site: the build writes them into the static files' `_headers` rules
 * (scripts/build-site.mjs), and the Worker sets them on every response it makes (site/worker.ts), because Cloudflare
 * applies `_headers` to static files only. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'sha256-ex8kSqwf1WiPVL0BhnAXX54XDAjFXEHkC+qlMJg0x4Q=' 'sha256-/bpm5bmsSEb1V97OjNCSeP/6USgbOt6CwVT1lPKPzK4=' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https: wss:; frame-src 'none'; worker-src 'self' blob:; manifest-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
};

/** The static files' `_headers` rules: every file gets the security headers. */
export function headersFile() {
  return `/*\n${Object.entries(SECURITY_HEADERS)
    .map(([name, value]) => `  ${name}: ${value}\n`)
    .join('')}`;
}

/** A copy of `response` with the security headers set (platform and fetched responses have immutable headers). */
export function secured(response: Response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
