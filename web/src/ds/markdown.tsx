// SPDX-License-Identifier: Apache-2.0
// Member-written Markdown (a comment, an Item's text) drawn safely: raw HTML is dropped, never parsed or run; links open
// only for http(s) and mailto, name their destination host on hover, and in-page anchors stay in place; images from
// outside are not loaded. Footnote ids carry the text's own prefix, so a footnote link never jumps to another comment.
// Kept out of the ds index so react-markdown loads with the screen that draws text, never at first paint.
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

const components: Components = {
  // `id` is kept on in-page anchors only: footnote references, whose ids carry the text's prefix.
  a: ({ children, href, id }) => {
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
  },
  img: ({ alt }) => <span className="t2">[Image: {alt || 'image'}. Outside images are not loaded.]</span>,
  // Headings in member text sit under the screen's own headings.
  h1: ({ children }) => <h3>{children}</h3>,
  h2: ({ children }) => <h3>{children}</h3>,
};

/** `idPrefix` (letters, digits and dashes) keeps footnote ids apart when several texts share a page. */
export function SafeMarkdown({ text, label, idPrefix }: { text: string; label?: string; idPrefix?: string }) {
  const prefix = idPrefix?.replace(/[^\w-]/g, '');
  return (
    <Prose {...(label ? { label } : {})}>
      <Markdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        remarkRehypeOptions={prefix ? { clobberPrefix: `user-content-${prefix}-` } : {}}
        components={components}
      >
        {text}
      </Markdown>
    </Prose>
  );
}
