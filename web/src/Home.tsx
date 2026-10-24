import { countLabel } from './ui/count';
import { ErrorToast } from './ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { DetailPanel } from './DetailPanel';
import { Children, createContext, isValidElement, useContext } from 'react';
import type { ReactNode } from 'react';
import { DocumentMarkdown, SourceView } from './Content';
import type { DocumentNavigation } from './Content';
import { ImportMap } from './Map';
import { endpoint, useQuery } from './api';
import type { SourceRequest, Page, ImportEdge, Readme, Route, Source, Status } from './api';

type Component =
  | { component: 'coverage' }
  | { component: 'work' }
  | { component: 'evidence' }
  | { component: 'releases' }
  | { component: 'imports'; file: string }
  | { component: 'impact'; file: string }
  | { component: 'source'; file: string; line: number };
function component(text: string): Component | null {
  try {
    const value = JSON.parse(text);
    if (!value || Array.isArray(value) || typeof value !== 'object') return null;
    const summary = ['coverage', 'work', 'evidence', 'releases'].includes(value.component);
    const allowed = summary
      ? ['component']
      : value.component === 'imports' || value.component === 'impact'
        ? ['component', 'file']
        : ['component', 'file', 'line'];
    if (Object.keys(value).some(key => !allowed.includes(key))) return null;
    if (summary) return { component: value.component };
    if (typeof value.file !== 'string' || !value.file) return null;
    if (value.component === 'imports') return { component: 'imports', file: value.file };
    if (value.component === 'impact') return { component: 'impact', file: value.file };
    const line = value.line === undefined ? 1 : value.line;
    return value.component === 'source' && Number.isSafeInteger(line) && line > 0
      ? { component: 'source', file: value.file, line }
      : null;
  } catch {
    return null;
  }
}
type Context = {
  request: SourceRequest;
  status: Status;
  navigate: (route: Partial<Route>) => void;
};
const HomeContext = createContext<Context | null>(null);
function HomeComponent({ text, request, status, navigate }: Context & { text: string }) {
  const block = component(text);
  const imports = useQuery<Page<ImportEdge>>(
    block?.component === 'imports' ? endpoint('imports', { file: block.file, state: status.sourceId }) : null,
    request,
  );
  const impact = useQuery<Page<ImportEdge> & { meaning: string }>(
    block?.component === 'impact' ? endpoint('impact', { file: block.file, state: status.sourceId }) : null,
    request,
  );
  const source = useQuery<Page<Source>>(
    block?.component === 'source'
      ? endpoint('source', {
          file: block.file,
          state: status.sourceId,
          start: block.line,
          end: block.line + 79,
        })
      : null,
    request,
  );
  if (!block)
    return (
      <div>
        <p>Unsupported Forge component. Original block:</p>
        <pre>{text}</pre>
      </div>
    );
  if (block.component === 'coverage')
    return (
      <section aria-label="Current analysis coverage">
        <h2>Analysis coverage</h2>
        <p>
          {countLabel(status.files, 'file')} · {status.symbols} declarations · {status.imports} imports ·{' '}
          {status.analysis.coverage} coverage
        </p>
        <DetailPanel title="Analysis details">
          <p>Fingerprints identify the exact source and analysis behind this coverage.</p>
          <p className="provenance">
            Source <code>{status.sourceId}</code>
            <br />
            Analysis <code>{status.analysisId}</code>
          </p>
        </DetailPanel>
        <ul>
          {status.analysis.limitations.map(item => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>
    );
  if (block.component === 'work' || block.component === 'evidence' || block.component === 'releases')
    return (
      <div>
        <p>
          This {block.component} component uses local Work records. Hosted source snapshots do not include
          local Work records.
        </p>
        <pre>{text}</pre>
      </div>
    );
  const result = block.component === 'imports' ? imports : block.component === 'impact' ? impact : source;
  if (result.error)
    return (
      <ErrorToast read>
        {block.file}: {result.error}
      </ErrorToast>
    );
  if (!result.data)
    return (
      <p>
        Loading {block.component} for {block.file}…
      </p>
    );
  if (block.component === 'impact')
    return (
      <>
        <ImportMap
          file={block.file}
          imports={impact.data!}
          direction="importers"
          select={file => navigate({ view: 'map', file, line: 1 })}
        />
        <p>{impact.data!.meaning}</p>
      </>
    );
  return block.component === 'imports' ? (
    <ImportMap
      file={block.file}
      imports={imports.data!}
      select={file => navigate({ view: 'map', file, line: 1 })}
    />
  ) : source.data!.results[0] ? (
    <SourceView
      source={source.data!.results[0]}
      selectedLine={block.line}
      navigate={line => navigate({ view: 'source', file: block.file, line })}
    />
  ) : (
    <p>
      No included source at {block.file}:{block.line}.
    </p>
  );
}
export function Home({
  document,
  navigation,
  ...context
}: Context & { document: Readme; navigation?: DocumentNavigation }) {
  return (
    <section className="document">
      <div className="pane-heading">
        <h1>Repository Home</h1>
        <p>
          {document.file ?? 'No .nforge/home.md found'} ·{' '}
          {document.scope === 'git-revision'
            ? 'indexed Git revision'
            : 'live document, separate from the indexed source state'}
        </p>
        {document.digest && (
          <DetailPanel title="Document details">
            <p>This fingerprint identifies the exact document being shown.</p>
            <p className="provenance">
              Document SHA-256 <code>{document.digest}</code>
            </p>
          </DetailPanel>
        )}
      </div>
      <HomeContext.Provider value={context}>
        <article className="markdown">
          <DocumentMarkdown
            text={
              document.text ||
              'Add .nforge/home.md to your repository to provide an optional Home page. README and source exploration remain available.'
            }
            file={document.file}
            navigation={navigation}
            pre={HomePre}
          />
        </article>
      </HomeContext.Provider>
    </section>
  );
}
function HomePre({ children }: { children?: ReactNode }) {
  const context = useContext(HomeContext),
    child = Children.toArray(children)[0];
  return context &&
    isValidElement<{ className?: string; children?: string }>(child) &&
    child.props.className === 'language-forge' ? (
    <HomeComponent text={String(child.props.children ?? '')} {...context} />
  ) : (
    <pre>{children}</pre>
  );
}
