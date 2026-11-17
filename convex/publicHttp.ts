// SPDX-License-Identifier: Apache-2.0
/** The public read route, GET /public/v1/… (Items 6a60e89a, 875a4b60). It is the origin behind the site's shared
 * cache (netlify/functions/public-read.mts): a cache hit is served from the CDN's storage and never reaches Convex,
 * so a page costs at most one call here per cache period, whatever the number of visitors or crawlers. Reads only:
 * the one write is the explore ranking's activity note, at most once per 10 minutes per project.
 *
 *   /public/v1/project/HANDLE/SLUG.json   a public project page, or 404
 *   /public/v1/explore/ORDER.json         active | stars | newest (also the in-browser search index)
 *   /public/v1/profile/HANDLE.json        a person's or organisation's public projects, or 404
 *   /public/v1/sitemap.xml                listed projects and profiles
 * Missing, private and removed answer with the same 404 body. */
import { httpAction } from './_generated/server';
import { internal } from './_generated/api';

/** Shared-cache lifetime: browsers always revalidate; the CDN keeps a page 30 seconds, with no stale serving. */
export const PUBLIC_CACHE = {
  browser: 'public, max-age=0, must-revalidate',
  shared: 'public, durable, s-maxage=30, must-revalidate',
};
const segment = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
const headers = (type: string) => ({
  'content-type': type,
  'cache-control': PUBLIC_CACHE.browser,
  'netlify-cdn-cache-control': PUBLIC_CACHE.shared,
  'x-content-type-options': 'nosniff',
  // Public data only: any origin may read it, never with credentials.
  'access-control-allow-origin': '*',
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: headers('application/json; charset=utf-8') });
const missing = () => json({ found: false }, 404);

export function publicPath(
  pathname: string,
):
  | { kind: 'project'; handle: string; slug: string }
  | { kind: 'explore'; order: 'active' | 'stars' | 'newest' }
  | { kind: 'profile'; handle: string }
  | { kind: 'sitemap' }
  | null {
  const parts = pathname.replace(/^\/public\/v1\//, '').split('/');
  const strip = (part: string | undefined, ext: string) =>
    part?.endsWith(ext) ? part.slice(0, -ext.length) : undefined;
  if (parts.length === 3 && parts[0] === 'project') {
    const handle = parts[1]!,
      slug = strip(parts[2], '.json');
    return segment.test(handle) && slug && segment.test(slug) ? { kind: 'project', handle, slug } : null;
  }
  if (parts.length === 2 && parts[0] === 'explore') {
    const order = strip(parts[1], '.json');
    return order === 'active' || order === 'stars' || order === 'newest' ? { kind: 'explore', order } : null;
  }
  if (parts.length === 2 && parts[0] === 'profile') {
    const handle = strip(parts[1], '.json');
    return handle && segment.test(handle) ? { kind: 'profile', handle } : null;
  }
  if (parts.length === 1 && parts[0] === 'sitemap.xml') return { kind: 'sitemap' };
  return null;
}

const xmlEscape = (text: string) =>
  text.replace(
    /[<>&'"]/g,
    c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!,
  );

/** The sitemap lists only what the public read lists; `origin` is the configured canonical web address. */
export function sitemapXml(origin: string, rows: readonly { handle: string; slug: string }[]) {
  const urls = new Set([`${origin}/-/explore`]);
  for (const { handle, slug } of rows) {
    urls.add(`${origin}/-/${encodeURIComponent(handle)}/${encodeURIComponent(slug)}`);
    urls.add(`${origin}/-/${encodeURIComponent(handle)}`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[
    ...urls,
  ]
    .map(url => `  <url><loc>${xmlEscape(url)}</loc></url>`)
    .join('\n')}\n</urlset>\n`;
}

/** Fixed-length digest comparison; the service key never enters a reply or a DB row. */
async function siteCaller(request: Request) {
  const key = process.env.FORGE_PUBLIC_READ_SECRET;
  const supplied = request.headers.get('x-forge-public-key');
  if (!key || !supplied) return false;
  const hash = async (value: string) =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [expected, actual] = await Promise.all([hash(key), hash(supplied)]);
  let different = 0;
  for (let i = 0; i < expected.length; i++) different |= expected[i]! ^ actual[i]!;
  return different === 0;
}

export const serve = httpAction(async (ctx, request) => {
  if (!(await siteCaller(request)))
    return new Response('Public reads use the site cache.', {
      status: 401,
      headers: { 'cache-control': 'no-store' },
    });
  const path = publicPath(new URL(request.url).pathname);
  if (!path) return missing();
  const now = Date.now();
  if (path.kind === 'project') {
    const page = await ctx.runQuery(internal.publicRead.projectPage, {
      handle: path.handle,
      slug: path.slug,
      now,
    });
    if (!page) return missing();
    const { stale, ...body } = page as { stale: boolean; project: { id: string }; activity: unknown };
    if (stale)
      await ctx.runMutation(internal.publicRead.noteActivity, {
        projectId: body.project.id as never,
        activity: body.activity as never,
      });
    return json(body);
  }
  if (path.kind === 'explore')
    return json(await ctx.runQuery(internal.publicRead.explorePage, { order: path.order, now }));
  if (path.kind === 'profile') {
    const page = await ctx.runQuery(internal.publicRead.profilePage, { handle: path.handle, now });
    return page ? json(page) : missing();
  }
  const origin = process.env.FORGE_WEB_URL;
  if (!origin || !/^https:\/\/[a-z0-9.-]+$/i.test(origin))
    return new Response('Public reads are not configured.', { status: 503 });
  const rows = await ctx.runQuery(internal.publicRead.sitemapRows, {});
  return new Response(sitemapXml(origin, rows), {
    headers: headers('application/xml; charset=utf-8'),
  });
});
