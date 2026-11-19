// SPDX-License-Identifier: Apache-2.0
// A held settings change, readable (Item 16093ed1): the summary line, a before/after row per changed field, each script
// as a wrapped line diff, and the request as sent only behind Details. Used by the approve page and by Needs me. The text
// is the agent's: drawn as text only (never as Markdown or HTML) and marked untrusted, with every hidden or
// direction-changing character drawn as a visible marker, so what reads here is what the grant applies.
import { useMemo } from 'react';
import {
  requestJson,
  revealHidden,
  settingChangeView,
  type ListEntry,
  type SettingCompare,
  type SettingOriginName,
} from './setting-change';
import './setting-change.css';

/** Agent text with each hidden character (U+202E and the like) shown as a marker instead of acting on the line. In
 * command text (`code`), every other non-ASCII character keeps its glyph and shows its code point, so a look-alike
 * letter (Cyrillic і in github.com) cannot pass as the trusted name. */
function Shown({ text, code = false }: { text: string; code?: boolean }) {
  return (
    <>
      {revealHidden(text, code).map((part, index) =>
        typeof part === 'string' ? (
          part
        ) : 'hidden' in part ? (
          <mark key={index} className="sc-hid" title={`Hidden character ${part.hidden}`}>
            {part.hidden}
          </mark>
        ) : (
          <mark key={index} className="sc-uni" title={`Non-ASCII character ${part.code}`}>
            {part.char}
            <span className="sc-cp">{part.code}</span>
          </mark>
        ),
      )}
    </>
  );
}

/** A list drawn whole and in order, one entry per chip, so a comma inside an entry never splits it. */
function Entries({ entries, code }: { entries: ListEntry[]; code: boolean }) {
  if (!entries.length) return <>none</>;
  return (
    <span className="sc-chips">
      {entries.map((entry, index) => (
        <span key={index} className="sc-chip" data-mark={entry.mark}>
          {entry.mark ? <span className="sc-vh">{entry.mark}: </span> : null}
          <Shown text={entry.text} code={code} />
        </span>
      ))}
    </span>
  );
}

export function SettingChange({
  origin,
  compare,
  change,
}: {
  origin: SettingOriginName | undefined;
  compare: SettingCompare | null | undefined;
  /** The request exactly as the agent sent it, internal fields included. */
  change: unknown;
}) {
  const view = useMemo(() => settingChangeView(origin, compare), [origin, compare]);
  // A held check import carries the check Forge read from Work (`pinned`): drawn apart from what the agent sent.
  const held = useMemo(() => {
    if (!change || typeof change !== 'object' || Array.isArray(change) || !('pinned' in change)) return null;
    const { pinned, ...sent } = change as Record<string, unknown>;
    return { pinned, sent };
  }, [change]);
  return (
    <div className="sc">
      <p className="sc-sum" dir="auto">
        <Shown text={view.summary} code />
      </p>
      {view.rows.length ? (
        <dl className="sc-rows">
          {view.rows.map(row => (
            <div key={row.path} className="sc-row" data-kind={row.kind}>
              <dt>
                <Shown text={row.label} />
              </dt>
              <dd>
                {row.added?.length ? (
                  <span className="sc-after" dir="auto">
                    <span className="sc-tag">{row.inserted ? 'inserts' : 'adds'}</span>{' '}
                    <Entries entries={row.added.map(text => ({ text }))} code={Boolean(row.command)} />
                  </span>
                ) : null}
                {row.dropped?.length ? (
                  <span className="sc-before" dir="auto">
                    <span className="sc-tag">drops</span>{' '}
                    <Entries entries={row.dropped.map(text => ({ text }))} code={Boolean(row.command)} />
                  </span>
                ) : null}
                {/* Every change shows both values whole; a list keeps its order (an inserted argument can change
                    what runs) with added and dropped entries marked. */}
                {row.afterEntries && row.beforeEntries ? (
                  <>
                    <span className="sc-before sc-list" dir="auto">
                      <span className="sc-tag">was</span>{' '}
                      <Entries entries={row.beforeEntries} code={Boolean(row.command)} />
                    </span>
                    <span className="sc-after sc-list" dir="auto">
                      <span className="sc-tag">asked</span>{' '}
                      <Entries entries={row.afterEntries} code={Boolean(row.command)} />
                      {row.reordered ? <span className="sc-tag"> (order changed)</span> : null}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="sc-before" dir="auto">
                      <span className="sc-tag">was</span> <Shown text={row.before} code={row.command} />
                    </span>
                    <span className="sc-after" dir="auto">
                      <span className="sc-tag">asked</span> <Shown text={row.after} code={row.command} />
                    </span>
                  </>
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {view.scripts.map(script => (
        <figure key={script.path} className="sc-script">
          <figcaption>
            <Shown text={script.label} />
          </figcaption>
          {script.lines ? (
            <pre className="sc-diff" tabIndex={0} aria-label={`${script.label}, line changes`}>
              {script.lines.map((line, index) => (
                <span key={index} className={`sc-l sc-${line.op}`}>
                  <span className="sc-op" aria-hidden="true">
                    {line.op === 'add' ? '+' : line.op === 'del' ? '−' : ' '}
                  </span>
                  <span className="sc-vh">
                    {line.op === 'add' ? 'added: ' : line.op === 'del' ? 'removed: ' : ''}
                  </span>
                  {line.text ? <Shown text={line.text} code /> : ' '}
                  {'\n'}
                </span>
              ))}
            </pre>
          ) : (
            <>
              <p className="sc-note">Too long to compare line by line; both versions follow.</p>
              <pre className="sc-diff sc-del" tabIndex={0} aria-label={`${script.label}, before`}>
                <Shown text={script.before || 'not set'} code />
              </pre>
              <pre className="sc-diff sc-add" tabIndex={0} aria-label={`${script.label}, asked`}>
                <Shown text={script.after || 'not set'} code />
              </pre>
            </>
          )}
        </figure>
      ))}
      {view.same && !view.unavailable ? (
        <p className="sc-note">
          {view.same.toLocaleString('en')} other{' '}
          {view.same === 1 ? 'field stays as it is.' : 'fields stay as they are.'}
        </p>
      ) : null}
      {/* With no comparison the request is all there is to read, so it starts open. */}
      <details className="sc-details" open={view.unavailable}>
        <summary>
          {held
            ? 'Details: the request as sent, and the check Forge read for it'
            : 'Details: the request as sent'}
        </summary>
        {held ? <p className="sc-note">Sent by the agent</p> : null}
        <pre className="sc-raw" tabIndex={0} aria-label="The request as sent">
          {requestJson(held ? held.sent : change)}
        </pre>
        {held ? (
          <>
            {/* Item 16093ed1: a check import names its check only; Forge read this from Work when it held the
                request, and the grant applies exactly it. */}
            <p className="sc-note">
              Read by Forge from Work when the request was held; granting applies this check
            </p>
            <pre className="sc-raw" tabIndex={0} aria-label="The check Forge read from Work">
              {requestJson(held.pinned)}
            </pre>
          </>
        ) : null}
      </details>
    </div>
  );
}
