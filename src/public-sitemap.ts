// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
export const publicSitemapKey = 'public-pages/v1/sitemap.json';
export const publicSitemapBytes = 4 * 1024 * 1024;
const xmlEscape = (text: string) =>
  text.replace(
    /[<>&'"]/g,
    c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!,
  );

/** The sitemap lists only the selected public projection, under the configured canonical origin. */
export function sitemapXml(origin: string, rows: readonly { handle: string; slug: string }[]) {
  const urls = new Set([`${origin}/explore`]);
  for (const { handle, slug } of rows) {
    urls.add(`${origin}/${encodeURIComponent(handle)}/${encodeURIComponent(slug)}`);
    urls.add(`${origin}/${encodeURIComponent(handle)}`);
  }
  if (urls.size > 50_000) throw new Error('The public sitemap exceeds the XML URL envelope.');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[
    ...urls,
  ]
    .map(url => `  <url><loc>${xmlEscape(url)}</loc></url>`)
    .join('\n')}\n</urlset>\n`;
}
