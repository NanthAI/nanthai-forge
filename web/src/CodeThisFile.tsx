// SPDX-License-Identifier: Apache-2.0
import { useState, type ReactNode } from 'react';
import { Avatar, Button, Panel, StatusPill } from './ui/primitives';
import { AutoTag } from './ui/signals';
import { Glyph } from './ui/Glyph';
import { age } from './ui/status';
import { rangeLabel, type CodeSymbol, type TouchLane } from './code-file-model';

/** A Lane on the selected file with the lines it changes there (absent while they load). */
export type FileLane = TouchLane & { lines?: readonly [number, number][] };
export type FileChange = {
  viewId: string;
  title: string;
  href: string;
  head: string;
  at: string;
  by?: string;
  auto: boolean;
  check?: string;
};

function Who({ lane, size = 'sm' }: { lane: FileLane; size?: 'sm' | 'md' }) {
  return <Avatar name={lane.holder} kind={lane.agent ? 'agent' : 'human'} size={size} />;
}

/** Under the file header, only when an open Lane touches the file; each entry opens that Lane's Changes. */
export function ChangingStrip({ lanes }: { lanes: readonly FileLane[] }) {
  if (!lanes.length) return null;
  return (
    <div className="code-changing-strip" aria-label="Changing this file">
      <strong>Changing this file</strong>
      {lanes.map(lane => (
        <a key={lane.id} href={lane.href} title={lane.name}>
          <Who lane={lane} />
          <span className="code-lane-name">{lane.holder}</span>
          <StatusPill tone={lane.tone} />
          {lane.lines?.length ? <span className="code-lines">{rangeLabel(lane.lines)}</span> : null}
        </a>
      ))}
    </div>
  );
}

export function ChangingNowPanel({ lanes }: { lanes: readonly FileLane[] }) {
  if (!lanes.length) return null;
  return (
    <Panel title="Changing now" count={lanes.length} className="code-side-panel">
      {lanes.map(lane => (
        <a className="code-lane-row" key={lane.id} href={lane.href}>
          <Who lane={lane} size="md" />
          <div>
            <div className="code-lane-who">
              <span>{lane.holder}</span>
              <StatusPill tone={lane.tone} />
            </div>
            <div className="code-lane-what">
              {lane.what}
              {lane.lines?.length ? (
                <>
                  {lane.what && ' · '}
                  <span className="code-nowrap">{rangeLabel(lane.lines)}</span>
                </>
              ) : null}
              {lane.saves
                ? `${lane.what || lane.lines?.length ? ' · ' : ''}${lane.saves} ${lane.saves === 1 ? 'save' : 'saves'}`
                : ''}
            </div>
          </div>
        </a>
      ))}
    </Panel>
  );
}

export function SymbolsPanel({
  symbols,
  href,
}: {
  symbols: readonly CodeSymbol[];
  href: (line: number) => string;
}) {
  if (!symbols.length) return null;
  return (
    <Panel title="Symbols" count={symbols.length} className="code-side-panel">
      {symbols.map(symbol => (
        <a className="code-symbol" key={`${symbol.name}:${symbol.line}`} href={href(symbol.line)}>
          <span className="code-symbol-kind">{symbol.kind}</span>
          <span className="code-symbol-name">{symbol.name}</span>
          <span className="code-symbol-line">L{symbol.line}</span>
        </a>
      ))}
    </Panel>
  );
}

const SHOWN = 3;
/** Accepted changes touching this file; `All` adds the rest with their exact heads. */
export function HistoryPanel({
  changes,
  loading,
  now,
}: {
  changes: readonly FileChange[];
  loading: boolean;
  now: number;
}) {
  const [all, setAll] = useState(false);
  if (!loading && !changes.length) return null;
  const shown = all ? changes : changes.slice(0, SHOWN);
  return (
    <section className="fx-panel code-side-panel" id="code-history" aria-labelledby="code-history-h">
      <header className="fx-panel-h">
        <h2 id="code-history-h">History</h2>
        {changes.length > 0 && (
          <button type="button" className="code-panel-act" aria-expanded={all} onClick={() => setAll(!all)}>
            {all ? 'Fewer' : 'All'}
          </button>
        )}
      </header>
      {loading && !changes.length && <p className="code-loading">Loading history…</p>}
      {shown.map(change => (
        <div className="code-history-row" key={change.viewId}>
          <Glyph name="passed" size={12} />
          <div>
            <a href={change.href}>{change.title}</a>
            <span className="code-history-by">
              {[change.by, change.check].filter(Boolean).join(' · ')}
              {change.auto && <AutoTag />}
              {all && <code>{change.head.slice(0, 12)}</code>}
            </span>
          </div>
          <span className="code-history-age">{age(change.at, now)}</span>
        </div>
      ))}
    </section>
  );
}

/** Path (directory muted, name bold) · size and age · actions; `Files` opens the tree on narrow screens. */
export function FileHeader({
  file,
  meta,
  files,
  actions,
}: {
  file: string;
  meta: string;
  files: () => void;
  actions: ReactNode;
}) {
  const slash = file.lastIndexOf('/') + 1;
  return (
    <div className="code-file-h">
      <Button variant="ghost" size="sm" icon="folder" className="code-files-btn" onClick={files}>
        Files
      </Button>
      <h2 className="code-file-path" title={file}>
        {slash > 0 && <span>{file.slice(0, slash)}</span>}
        {file.slice(slash)}
      </h2>
      {meta && <span className="code-file-meta">{meta}</span>}
      <div className="code-file-acts">{actions}</div>
    </div>
  );
}
