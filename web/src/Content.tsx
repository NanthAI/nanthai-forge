import { ErrorToast } from './ui/Toast';
import { ObjectActions } from './shell/ObjectActions';
import { routeUrlState } from './shell/location';
import { SyntaxLine } from './SourceTokens';
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PageTabs } from './WorkspaceUI';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import { documentTarget, type DocumentTarget } from '../../src/document-paths';
import type { Page, Readme, Source, SymbolNode, ImportEdge, ReferenceEdge } from './api';
type MarkdownNode = {
  type: string;
  value?: string;
  depth?: number;
  children?: MarkdownNode[];
  data?: { hProperties?: Record<string, unknown> };
};
function documentHeadings() {
  return (tree: MarkdownNode) => {
    const seen = new Set<string>();
    const text = (node: MarkdownNode): string => node.value ?? node.children?.map(text).join('') ?? '';
    const visit = (node: MarkdownNode) => {
      if (node.type === 'heading') {
        const base = text(node)
          .toLowerCase()
          .replace(/[^\p{L}\p{N}_\-\s]/gu, '')
          .replace(/\s/g, '-');
        let slug = base,
          suffix = 0;
        while (seen.has(slug)) slug = `${base}-${++suffix}`;
        seen.add(slug);
        node.data = {
          ...node.data,
          hProperties: { ...node.data?.hProperties, id: `forge-document-${slug}`, tabIndex: -1 },
        };
        node.depth = Math.min(6, (node.depth ?? 1) + 1);
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
export type DocumentNavigation = {
  href: (target: DocumentTarget) => string;
  open: (target: DocumentTarget) => void;
};
export function DocumentMarkdown({
  text,
  file,
  navigation,
  pre,
}: {
  text: string;
  file?: string | null;
  navigation?: DocumentNavigation;
  pre?: Components['pre'];
}) {
  return (
    <Markdown
      skipHtml
      remarkPlugins={[remarkGfm, documentHeadings]}
      components={{
        img: ({ alt }) => (
          <span className="muted">[Image: {alt ?? 'image'} — external images are not loaded]</span>
        ),
        a: ({ children, href }) => {
          if (href && /^https?:\/\//i.test(href))
            return (
              <a href={href} rel="noreferrer noopener" target="_blank">
                {children}
              </a>
            );
          const target = href && file && navigation ? documentTarget(href, file) : null;
          return target && navigation ? (
            <a
              href={navigation.href(target)}
              onClick={event => {
                if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                navigation.open(target);
              }}
            >
              {children}
            </a>
          ) : (
            <span>{children}</span>
          );
        },
        ...(pre ? { pre } : {}),
      }}
    >
      {text}
    </Markdown>
  );
}
export function ReadmeView({ readme, navigation }: { readme: Readme; navigation?: DocumentNavigation }) {
  const zone = readme.scope === 'file-zone-projection';
  return (
    <section className="document">
      <div className="pane-heading">
        <h1>{zone ? 'Source Zone documents' : (readme.file ?? 'No README found')}</h1>
        <p>
          {zone
            ? 'Documents are outside this selected-file snapshot'
            : readme.scope === 'git-revision'
              ? 'Document from the indexed Git revision'
              : 'Live document · separate from the indexed source state'}
        </p>
      </div>
      <article className="markdown">
        <DocumentMarkdown
          text={readme.text || 'This repository has no readable, unignored root README.md.'}
          file={readme.file}
          navigation={zone ? undefined : navigation}
        />
      </article>
    </section>
  );
}
export function SourceView({
  source,
  selectedLine,
  navigate,
  changing,
  touchedLines = [],
  head,
  header,
}: {
  head?: string;
  changing?: ReactNode;
  /** Replaces the default heading (hosted Code draws its own file header). */
  header?: ReactNode;
  /** Inclusive ranges; an optional tone colours the gutter mark (default `active`). */
  touchedLines?: readonly (readonly [number, number, string?])[];
  source: Source;
  selectedLine?: number;
  navigate: (line: number) => void;
}) {
  const target = useRef<HTMLDivElement>(null);
  useEffect(() => {
    target.current?.scrollIntoView({ block: 'center' });
  }, [source.file, source.digest, selectedLine]);
  return (
    <section className="source-pane source">
      {header ?? (
        <div className="pane-heading">
          <h2>{source.file}</h2>
          <ObjectActions
            head={head ?? routeUrlState().searchParams.get('head') ?? undefined}
            file={source.file}
            line={selectedLine}
          />
          <p>
            Lines {source.startLine}–{source.endLine}
          </p>
        </div>
      )}
      {changing}
      <div className="code-scroll">
        <pre>
          {source.text.split('\n').map((line, i) => {
            const touch = touchedLines.find(
              ([start, end]) => source.startLine + i >= start && source.startLine + i <= end,
            );
            return (
              <div
                ref={source.startLine + i === selectedLine ? target : undefined}
                id={`L${source.startLine + i}`}
                className={`code-line ${source.startLine + i === selectedLine ? 'active-line' : ''} ${touch ? `lane-touched-line touch-${touch[2] ?? 'active'}` : ''}`}
                key={i}
              >
                <span className="line-number">{source.startLine + i}</span>
                <code>
                  <SyntaxLine
                    text={line}
                    file={source.file}
                    blob={source.digest}
                    range={String(source.startLine + i)}
                    plain={source.text.length > 1_000_000}
                  />
                </code>
              </div>
            );
          })}
        </pre>
      </div>
      <div className="source-controls">
        <button
          disabled={source.startLine === 1}
          onClick={() => navigate(Math.max(1, source.startLine - 80))}
        >
          Previous lines
        </button>
        <button disabled={source.endLine >= source.totalLines} onClick={() => navigate(source.endLine + 1)}>
          Next lines
        </button>
      </div>
    </section>
  );
}
function kindLabel(kind: string): string {
  return kind
    .replace(/Declaration$/, '')
    .replace(/Signature$/, '')
    .toLowerCase();
}
export function Inspector({
  file,
  declarations,
  imports,
  references,
  referenceError,
  selectedSymbol,
  selectSymbol,
  referenceMap,
  source,
  select,
  activity,
  changing,
  incoming,
  incomingError,
  link,
}: {
  file: string;
  declarations: Page<SymbolNode> | null;
  imports: Page<ImportEdge> | null;
  references: Page<ReferenceEdge> | null;
  referenceError: string;
  selectedSymbol: string;
  selectSymbol: (id: string) => void;
  source: (file: string, line: number) => void;
  select: (file: string) => void;
  referenceMap: (id: string) => void;
  link: string;
  activity?: ReactNode;
  changing?: ReactNode;
  incoming?: Page<ImportEdge> | null;
  incomingError?: string;
}) {
  const [tab, setTab] = useState<'symbols' | 'relationships' | 'history'>('symbols');
  return (
    <aside className="inspector" aria-label="File inspector">
      <h2>This file</h2>
      <p className="inspector-file">{file || 'Select a file'}</p>
      <p>{imports ? `${imports.total} imports` : ''}</p>
      <div className="inspector-actions">
        <button className="primary" disabled={!file} onClick={() => source(file, 1)}>
          Open source
        </button>
        <ObjectActions file={file} line={1} href={link} />
      </div>

      {changing}
      <PageTabs
        label="File details"
        value={tab}
        onChange={setTab}
        items={[
          { id: 'symbols', label: 'Symbols' },
          { id: 'relationships', label: 'Related' },
          { id: 'history', label: 'History' },
        ]}
      />
      <div hidden={tab !== 'symbols'}>
        <div className="inspector-section">
          <h3>Declarations</h3>
          {declarations?.results.map(node => (
            <div className="declaration" key={node.id}>
              <button
                title={`Open ${node.name} at line ${node.locator.start.line}`}
                onClick={() => source(file, node.locator.start.line)}
              >
                <strong>{node.name}</strong>
                <span>{kindLabel(node.kind)}</span>
              </button>
              <button
                className="text-button"
                aria-pressed={selectedSymbol === node.id}
                onClick={() => selectSymbol(node.id)}
              >
                References
              </button>
              <button
                className="text-button"
                onClick={() => referenceMap(node.id)}
                aria-label={`Reference map for ${node.name} at line ${node.locator.start.line}`}
              >
                Reference map
              </button>
            </div>
          ))}
          {declarations?.results.length === 0 && <p>No supported declarations.</p>}
          {declarations?.truncated && <p>Showing the first {declarations.results.length} declarations.</p>}
        </div>

        {selectedSymbol && (
          <div className="inspector-section">
            <h3>References</h3>
            {referenceError && <ErrorToast read>{referenceError}</ErrorToast>}
            {references?.results.map((ref, i) => (
              <button
                className="list-button"
                key={i}
                onClick={() => source(ref.locator.file, ref.locator.start.line)}
              >
                {ref.locator.file}:{ref.locator.start.line}
              </button>
            ))}
            {references?.total === 0 && <p>No supported references found.</p>}
            {references?.truncated && (
              <p>
                Showing {references.results.length} of {references.total} references.
              </p>
            )}
          </div>
        )}
      </div>
      <section hidden={tab !== 'relationships'} className="inspector-section">
        <h3>Imports</h3>
        {imports?.results.map((edge, i) =>
          edge.target ? (
            <button className="list-button" key={i} onClick={() => select(edge.target!)}>
              {edge.specifier}
            </button>
          ) : (
            <p key={i}>
              <code>{edge.specifier}</code> · {edge.resolution}
            </p>
          ),
        )}
        {imports?.truncated && (
          <p>
            Showing {imports.results.length} of {imports.total} imports.
          </p>
        )}
        <h3>Imported by</h3>
        {incomingError && <ErrorToast read>{incomingError}</ErrorToast>}
        {incoming?.results.map((edge, i) => (
          <button className="list-button" key={i} onClick={() => select(edge.from)}>
            {edge.from}
          </button>
        ))}
        {incoming?.total === 0 && <p>No direct importers recorded.</p>}
        {incoming?.truncated && (
          <p>
            Showing {incoming.results.length} of {incoming.total} importers.
          </p>
        )}
        <small>Static imports only. Runtime effects remain unknown.</small>
      </section>
      <div hidden={tab !== 'history'}>{tab === 'history' && activity}</div>
    </aside>
  );
}
