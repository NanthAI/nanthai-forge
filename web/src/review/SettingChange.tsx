// SPDX-License-Identifier: Apache-2.0
// A held settings change, readable (Item 16093ed1): the summary line, a before/after row per changed field, each script
// as a wrapped line diff, and the request as sent only behind Details. Used by the approve page and by Needs me. The text
// is the agent's: drawn as text only (never as Markdown or HTML) and marked untrusted.
import { useMemo } from 'react';
import { settingChangeView, type SettingCompare, type SettingOriginName } from './setting-change';
import './setting-change.css';

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
  return (
    <div className="sc">
      <p className="sc-sum" dir="auto">
        {view.summary}
      </p>
      {view.rows.length ? (
        <dl className="sc-rows">
          {view.rows.map(row => (
            <div key={row.path} className="sc-row" data-kind={row.kind}>
              <dt>{row.label}</dt>
              <dd>
                {row.added || row.dropped ? (
                  <>
                    {row.added?.length ? (
                      <span className="sc-after" dir="auto">
                        <span className="sc-tag">adds</span> {row.added.join(', ')}
                      </span>
                    ) : null}
                    {row.dropped?.length ? (
                      <span className="sc-before" dir="auto">
                        <span className="sc-tag">drops</span> {row.dropped.join(', ')}
                      </span>
                    ) : null}
                    {!row.added?.length && !row.dropped?.length ? (
                      <span className="sc-after" dir="auto">
                        <span className="sc-tag">now</span> {row.after}{' '}
                        <span className="sc-tag">(order changed)</span>
                      </span>
                    ) : null}
                  </>
                ) : (
                  <>
                    <span className="sc-before" dir="auto">
                      <span className="sc-tag">was</span> {row.before}
                    </span>
                    <span className="sc-after" dir="auto">
                      <span className="sc-tag">asked</span> {row.after}
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
          <figcaption>{script.label}</figcaption>
          {script.lines ? (
            <pre className="sc-diff" aria-label={`${script.label}, line changes`}>
              {script.lines.map((line, index) => (
                <span key={index} className={`sc-l sc-${line.op}`}>
                  <span className="sc-op" aria-hidden="true">
                    {line.op === 'add' ? '+' : line.op === 'del' ? '−' : ' '}
                  </span>
                  <span className="sc-vh">
                    {line.op === 'add' ? 'added: ' : line.op === 'del' ? 'removed: ' : ''}
                  </span>
                  {line.text || ' '}
                  {'\n'}
                </span>
              ))}
            </pre>
          ) : (
            <>
              <p className="sc-note">Too long to compare line by line; both versions follow.</p>
              <pre className="sc-diff sc-del">{script.before || 'not set'}</pre>
              <pre className="sc-diff sc-add">{script.after || 'not set'}</pre>
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
      <details className="sc-details">
        <summary>Details: the request as sent</summary>
        <pre className="sc-raw">{JSON.stringify(change ?? null, null, 2)}</pre>
      </details>
    </div>
  );
}
