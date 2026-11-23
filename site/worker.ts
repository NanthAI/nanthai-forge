// SPDX-License-Identifier: Apache-2.0
/** The web site's Worker (Item ef6aa22a). Cloudflare serves the built static files (hosted-web-dist) first, for free,
 * with the `_headers` rules; this runs only for an address that is no static file:
 * - device sign-in start and renewal (site/device-auth.ts);
 * - the cached public read: public pages, their data under /-/public/v1/, the sitemap and the permanent 301 for the
 *   earlier "/-" addresses (site/public-read.ts);
 * - every other address gets the signed-in app (app.html), as the old "/*" rewrite did. "/" is the static public page.
 * Every response it makes carries the site's security headers (site/headers.ts). */
import { DEVICE_PATHS, deviceAuth } from './device-auth';
import { appShell, isPublicReadPath, publicRead } from './public-read';
import { secured } from './headers';
import type { SiteContext, SiteEnv } from './env';

async function app(request: Request, env: SiteEnv) {
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
  const html = await appShell(env, new URL(request.url));
  return new Response(request.method === 'HEAD' ? null : html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=0, must-revalidate',
    },
  });
}

export async function serve(request: Request, env: SiteEnv, ctx?: SiteContext) {
  const url = new URL(request.url);
  // Cloudflare sets this header itself at its edge; a visitor cannot supply it.
  const ip = request.headers.get('cf-connecting-ip');
  let response: Response;
  try {
    if (DEVICE_PATHS.includes(url.pathname)) response = await deviceAuth(request, env, ip);
    else if (isPublicReadPath(url.href)) response = await publicRead(request, env, ip, ctx);
    else response = await app(request, env);
  } catch {
    response = new Response('The site is unavailable; try again.', {
      status: 502,
      headers: { 'cache-control': 'no-store', 'content-type': 'text/plain' },
    });
  }
  return secured(response);
}

export default { fetch: serve };
