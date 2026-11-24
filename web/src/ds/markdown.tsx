// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Member-written Markdown (a comment, an Item's text) drawn safely: raw HTML is dropped, never parsed or run; links open
// only for http(s) and mailto, name their destination host on hover, and in-page anchors stay in place; images from
// outside are not loaded. Footnote ids carry the text's own prefix, so a footnote link never jumps to another comment.
// Kept out of the ds index so react-markdown loads with the screen that draws text, never at first paint.
import { useMemo, type ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prose } from './parts';

/** Where a member-written link may go: an absolute http(s) or mailto address, or an anchor on this page. */
export function safeHref(href: string | undefined) {
  if (!href) return null;
  const value = href.trim();
  if (/^#[\w-]+$/.test(value)) return { href: value, external: false };
  if (/^(https?:\/\/|mailto:)/i.test(value)) return { href: value, external: true };
  return null;
}

/** The host an outside link leads to, as hover text: link text can say one address and lead to another. */
function destination(href: string) {
  if (/^mailto:/i.test(href)) return href.slice('mailto:'.length);
  try {
    return new URL(href).host;
  } catch {
    return href;
  }
}

// `id` is kept on in-page anchors only: footnote references, whose ids carry the text's prefix.
function SafeLink({
  children,
  href,
  id,
}: {
  children?: ReactNode;
  href?: string | undefined;
  id?: string | undefined;
}) {
  const target = safeHref(href);
  if (!target) return <span>{children}</span>;
  return target.external ? (
    <a
      href={target.href}
      rel="noreferrer noopener nofollow ugc"
      target="_blank"
      title={`Opens ${destination(target.href)}`}
    >
      {children}
    </a>
  ) : (
    <a href={target.href} id={id}>
      {children}
    </a>
  );
}
const OutsideImage = ({ alt }: { alt?: string | undefined }) => (
  <span className="t2">[Image: {alt || 'image'}. Outside images are not loaded.]</span>
);

const components: Components = {
  a: SafeLink,
  img: OutsideImage,
  // Headings in member text sit under the screen's own headings.
  h1: ({ children }) => <h3>{children}</h3>,
  h2: ({ children }) => <h3>{children}</h3>,
};

/** A Markdown file read inside its repository (the Code reader): links and images that name another file of the same
 * State, and fenced code the caller colours. Each returns null when the reference is not drawn (it leaves the
 * repository, or no reader can load it), and the text falls back to the plain, safe rendering. */
export type RepoMarkdown = {
  link: (href: string, children: ReactNode) => ReactNode | null;
  image: (src: string, alt: string) => ReactNode | null;
  code: (text: string, lang: string | undefined) => ReactNode;
};

const fenceLanguage = (className: string | undefined) =>
  /(?:^|\s)language-([\w+#-]+)/.exec(className ?? '')?.[1];

function repoComponents(repo: RepoMarkdown): Components {
  return {
    ...components,
    a: ({ children, href, id }) =>
      (href && !safeHref(href) && !/^\s*(#|[a-z][a-z0-9+.-]*:)/i.test(href)
        ? repo.link(href, children)
        : null) ?? (
        <SafeLink href={href} id={id}>
          {children}
        </SafeLink>
      ),
    img: ({ src, alt }) =>
      (typeof src === 'string' && !/^\s*([a-z][a-z0-9+.-]*:|\/\/)/i.test(src)
        ? repo.image(src, alt ?? '')
        : null) ?? <OutsideImage alt={alt} />,
    code: ({ children, className }) => {
      const text = String(children ?? '');
      const lang = fenceLanguage(className);
      return lang !== undefined || text.includes('\n') ? (
        <code>{repo.code(text.replace(/\n$/, ''), lang)}</code>
      ) : (
        <code>{children}</code>
      );
    },
  };
}

/** `idPrefix` (letters, digits and dashes) keeps footnote ids apart when several texts share a page. */
export function SafeMarkdown({
  text,
  label,
  idPrefix,
  repo,
  scrollTables = false,
}: {
  text: string;
  label?: string;
  idPrefix?: string;
  repo?: RepoMarkdown;
  scrollTables?: boolean;
}) {
  const prefix = idPrefix?.replace(/[^\w-]/g, '');
  const repoParts = useMemo(() => {
    const parts = repo ? repoComponents(repo) : components;
    if (!scrollTables) return parts;
    return {
      ...parts,
      table: ({ children }: { children?: ReactNode }) => (
        <div className="pp-wide" role="region" aria-label="README table" tabIndex={0}>
          <table>{children}</table>
        </div>
      ),
    };
  }, [repo, scrollTables]);
  return (
    <Prose {...(label ? { label } : {})}>
      <Markdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        remarkRehypeOptions={prefix ? { clobberPrefix: `user-content-${prefix}-` } : {}}
        components={repoParts}
      >
        {text}
      </Markdown>
    </Prose>
  );
}
