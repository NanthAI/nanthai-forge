// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// A Markdown file read as a document (Item 8e847a17): the text drawn by the same safe renderer comments use (raw HTML
// is dropped, links open only to http(s), mailto, or another file of this State), fenced code coloured by the
// highlight worker, and raster images that name a file of the same State loaded from storage when they scroll into view:
// one read of the image's entry (no bytes) and one signed download, only for a member, only up to the drawing limit. A signed-out
// visitor's images, and any that cannot load, stay the plain "[Image: …]" words. Loaded only when a Markdown file opens.
import { useConvex } from 'convex/react';
import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Tokens } from '../../code-tokens';
import { SafeMarkdown, type RepoMarkdown } from '../../ds/markdown';
import { requestHighlight } from '../../highlight-client';
import type { SourceToken } from '../../source-highlight';
import { readExact } from '../lane/file-diff';
import { A } from '../frames';
import { browse, useReader, VisitorCodeContext, type Opened, type ProjectId } from './code-data';
import { repoPathFrom } from './code-words';

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
};

export type MarkdownSource = {
  projectId: ProjectId;
  /** The exact State the file is read at; relative images come from it. */
  state: string;
  path: string;
  /** The address of a file of this State in the Files view. */
  href: (path: string) => string;
};

function Fence({ text, lang }: { text: string; lang: string | undefined }) {
  const [lines, setLines] = useState<SourceToken[][] | null>(null);
  useEffect(() => {
    let live = true;
    void requestHighlight(`fence.${lang ?? 'txt'}`, text).then(result => live && setLines(result));
    return () => {
      live = false;
    };
  }, [text, lang]);
  const source = text.split('\n');
  return (
    <>
      {source.map((line, i) => (
        <span key={i}>
          <Tokens tokens={lines?.[i]} text={line} />
          {i < source.length - 1 ? '\n' : ''}
        </span>
      ))}
    </>
  );
}

/** One image of this State, read when it first nears the screen. The object URL is revoked when it leaves. */
function RepoImage({ source, path, alt }: { source: MarkdownSource; path: string; alt: string }) {
  const client = useConvex();
  const reader = useReader();
  const holder = useRef<HTMLSpanElement>(null);
  const [near, setNear] = useState(typeof IntersectionObserver === 'undefined');
  const [shown, setShown] = useState<{ url: string } | 'failed' | null>(null);
  const extension = path.split('.').at(-1)?.toLowerCase() ?? '';
  const type = Object.hasOwn(IMAGE_TYPES, extension) ? IMAGE_TYPES[extension] : undefined;
  useEffect(() => {
    const node = holder.current;
    if (near || !node) return;
    const watch = new IntersectionObserver(entries => entries.some(e => e.isIntersecting) && setNear(true), {
      rootMargin: '200px',
    });
    watch.observe(node);
    return () => watch.disconnect();
  }, [near]);
  useEffect(() => {
    if (!near || !type) return;
    let live = true,
      url = '';
    void (async () => {
      const opened = await browse<Opened>(reader, {
        projectId: source.projectId,
        state: source.state,
        want: 'entry',
        path,
      });
      const blob = opened.file && 'blob' in opened.file ? opened.file.blob : null;
      if (!blob) throw new Error('missing');
      const read = await readExact(client, source.projectId, [blob]);
      if (read.large) throw new Error('large');
      url = URL.createObjectURL(new Blob([read.bytes.get(blob)! as BlobPart], { type }));
      if (live) setShown({ url });
      else URL.revokeObjectURL(url);
    })().catch(() => live && setShown('failed'));
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [near, type, path, source.projectId, source.state, client, reader]);
  if (shown && shown !== 'failed') return <img src={shown.url} alt={alt} style={{ maxWidth: '100%' }} />;
  return (
    <span ref={holder} className="t2">
      [Image: {alt || path}
      {shown === 'failed' ? ' could not load' : ''}.]
    </span>
  );
}

export default function MarkdownFile({ text, source }: { text: string; source: MarkdownSource }) {
  const visitor = useContext(VisitorCodeContext);
  // Stable between renders (the file's next page arrives as a re-render): the renderer's components and every image
  // keep their identity, so a visible image is never read twice.
  const href = useRef(source.href);
  href.current = source.href;
  const { projectId, state, path } = source;
  const stable = useMemo<MarkdownSource>(
    () => ({ projectId, state, path, href: to => href.current(to) }),
    [projectId, state, path],
  );
  const repo = useMemo<RepoMarkdown>(
    () => ({
      link: (to, children): ReactNode => {
        const target = repoPathFrom(stable.path, to);
        return target ? <A href={stable.href(target)}>{children}</A> : null;
      },
      // A signed-out visitor has no signed download, so their images stay words.
      image: (src, alt) => {
        const target = visitor ? null : repoPathFrom(stable.path, src);
        return target ? <RepoImage source={stable} path={target} alt={alt} /> : null;
      },
      code: (code, lang) => <Fence text={code} lang={lang} />,
    }),
    [stable, visitor],
  );
  return <SafeMarkdown text={text} label={path} repo={repo} />;
}
