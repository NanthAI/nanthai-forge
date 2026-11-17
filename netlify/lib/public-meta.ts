// SPDX-License-Identifier: Apache-2.0
/** Page titles, descriptions and share-card tags for public pages (Item 875a4b60). Pure: the site's public function
 * (netlify/functions/public-read.mts) fills them from the cached public read, so a crawler or link preview gets them
 * without running the app and without a Convex call on a cache hit. Only what the public read already shows is used;
 * a private or missing project gets the plain app page, the same for both. Never loaded by the CLI or MCP. */

export type PublicProjectPage = {
  project: { handle: string; slug: string; name: string };
  stars: number;
  activity: { landings: number; main: 'passing' | 'unchecked'; recordedSince?: number };
  plan: { shown: boolean; left?: number };
  lanes: { open: number };
};
export type PageMeta = {
  title: string;
  description: string;
  url: string;
  image: string;
  kind: 'website' | 'profile';
};

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

export function projectMeta(origin: string, page: PublicProjectPage): PageMeta {
  const { handle, slug, name } = page.project;
  const facts = [
    page.activity.main === 'passing' ? 'Main is passing' : 'Main is not checked',
    `${plural(page.activity.landings, 'change')} ${page.activity.recordedSince ? 'recorded this week' : 'landed this week'}`,
    `${plural(page.lanes.open, 'Lane')} open`,
    ...(page.plan.shown && typeof page.plan.left === 'number'
      ? [`${plural(page.plan.left, 'Item')} left`]
      : []),
    plural(page.stars, 'star'),
  ];
  return {
    title: `${handle}/${name} · Forge`,
    description: `${facts.join('. ')}.`,
    url: `${origin}/-/${encodeURIComponent(handle)}/${encodeURIComponent(slug)}`,
    image: `${origin}/forge-badge-256.png`,
    kind: 'website',
  };
}

export function profileMeta(origin: string, page: { handle: string; projects: unknown[] }): PageMeta {
  return {
    title: `@${page.handle} · Forge`,
    description: `${plural(page.projects.length, 'public project')} by @${page.handle} on Forge.`,
    url: `${origin}/-/${encodeURIComponent(page.handle)}`,
    image: `${origin}/forge-badge-256.png`,
    kind: 'profile',
  };
}

export function exploreMeta(origin: string, page: { total: number; more?: boolean }): PageMeta {
  return {
    title: 'Explore public projects · Forge',
    description: `${plural(page.total, 'public project')}${page.more ? ' and more' : ''} on Forge, ordered by what landed this week.`,
    url: `${origin}/-/explore`,
    image: `${origin}/forge-badge-256.png`,
    kind: 'website',
  };
}

const attr = (text: string) =>
  text.replace(
    /[<>&"']/g,
    c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/** The app page with its title replaced and the share tags added to <head>. Adds no script, so the page's content
 * policy (inline script hashes) is unchanged. */
export function withMeta(html: string, meta: PageMeta): string {
  const tags = [
    `<title>${attr(meta.title)}</title>`,
    `<meta name="description" content="${attr(meta.description)}"/>`,
    `<link rel="canonical" href="${attr(meta.url)}"/>`,
    `<meta property="og:type" content="${meta.kind}"/>`,
    `<meta property="og:site_name" content="Forge"/>`,
    `<meta property="og:title" content="${attr(meta.title)}"/>`,
    `<meta property="og:description" content="${attr(meta.description)}"/>`,
    `<meta property="og:url" content="${attr(meta.url)}"/>`,
    `<meta property="og:image" content="${attr(meta.image)}"/>`,
    `<meta name="twitter:card" content="summary"/>`,
    `<meta name="twitter:title" content="${attr(meta.title)}"/>`,
    `<meta name="twitter:description" content="${attr(meta.description)}"/>`,
    `<meta name="twitter:image" content="${attr(meta.image)}"/>`,
  ].join('');
  const withoutTitle = html.replace(/<title>[^<]*<\/title>/, '');
  return withoutTitle.includes('</head>') ? withoutTitle.replace('</head>', () => `${tags}</head>`) : html;
}
