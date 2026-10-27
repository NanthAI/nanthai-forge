import { TestContract } from './TestContract';
import { ErrorToast } from '../ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { useMemo, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import { Button, Panel } from '../ui/primitives';
import { age } from '../ui/status';
import { useNow } from '../shell/StatusBar';
import { reviewGroups, type ReviewRead } from './review-model';
import './review.css';
export function ReviewStory({
  data,
  error,
  outcome,
  intentHref,
  laneName,
  overlaps,
  protectedPaths = [],
  children,
}: {
  data: ReviewRead | null;
  error?: string;
  outcome: string;
  intentHref: string;
  laneName: (id: string) => string;
  overlaps?: ReadonlyMap<string, string[]>;
  protectedPaths?: readonly string[];
  children: (paths: readonly string[] | undefined, title: string) => ReactNode;
}) {
  const now = useNow();
  const [selected, select] = useState('');
  const [expanded, expand] = useState(false);
  const groups = useMemo(() => reviewGroups(data?.files.items ?? []), [data]);
  const current = groups.find(group => group.id === selected) ?? groups[0];
  const notes = [
    ...new Map(
      (data?.files.items ?? [])
        .flatMap(file => file.why?.flatMap(why => why.notes) ?? [])
        .map(note => [note.id, note]),
    ).values(),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 3);
  return (
    <>
      <TestContract contract={data?.contract} />
      {Boolean(data?.semanticConflicts?.length) && (
        <Panel title="Intent semantic conflict" count={data!.semanticConflicts.length}>
          {data!.semanticConflicts.map(conflict => (
            <div key={`${conflict.runId}:${conflict.intents.map(intent => intent.intentId).join(':')}`}>
              <p className="fx-panel-note">
                {conflict.intents.map((intent, index) => (
                  <span key={intent.intentId}>
                    {index ? ' + ' : ''}
                    {intent.outcome} (<code>{intent.intentId}</code>)
                  </span>
                ))}
              </p>
              <ul className="fx-test-contract-tests">
                {conflict.failedTests.map(path => (
                  <li key={path}>
                    <code>{path}</code> failed together
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </Panel>
      )}
      {(notes.length > 0 || Boolean(overlaps?.size) || protectedPaths.length > 0) && (
        <Panel title="What this does and why" actions={<a href={intentHref}>Open Intent</a>}>
          {notes.length > 0 && (
            <ul className="fx-review-notes">
              {notes.map(note => (
                <li key={note.id}>
                  <q>
                    <ReactMarkdown components={{ p: ({ children }) => <span>{children}</span> }}>
                      {note.excerpt}
                    </ReactMarkdown>
                  </q>
                  <small title={note.at}>
                    {note.kind} · {age(note.at, now, true)}
                  </small>
                </li>
              ))}
            </ul>
          )}
          {overlaps?.size || protectedPaths.length ? (
            <div className="fx-review-risks">
              {overlaps &&
                [...overlaps].map(([path, lanes]) => (
                  <span key={path}>
                    ↔ {path} · overlaps {lanes.join(', ')}
                  </span>
                ))}
              {protectedPaths.map(path => (
                <span key={path}>◇ {path} · a person accepts</span>
              ))}
            </div>
          ) : null}
        </Panel>
      )}
      <Panel
        title="Changes, in the order they were built"
        count={data ? `${groups.length} ${groups.length === 1 ? 'group' : 'groups'}` : undefined}
        actions={
          <span
            title="Each group is a recorded Lane save. The diff shows this Candidate’s final changes to that save’s files."
            aria-label="How groups are made"
          >
            ⓘ
          </span>
        }
      >
        {error ? (
          <ErrorToast read>{error}</ErrorToast>
        ) : !data ? (
          <div className="fx-review-groups-loading" role="status">
            Reading save history…
          </div>
        ) : (
          <>
            <div className="fx-review-groups">
              {(expanded ? groups : groups.slice(0, 5)).map((group, index) => (
                <button
                  key={group.id}
                  type="button"
                  aria-pressed={group.id === current?.id}
                  onClick={() => select(group.id)}
                >
                  <span className="fx-review-number">{index + 1}</span>
                  <span className="fx-review-purpose">
                    <b title={group.message}>
                      {group.message === outcome ? `Save ${group.saveIndex + 1}` : group.message}
                    </b>
                    <small className="fx-review-path" title={group.paths.join(' · ')}>
                      {group.paths.slice(0, 2).join(' · ')}
                      {group.paths.length > 2 ? ` · +${group.paths.length - 2} more` : ''}
                    </small>
                    <small>
                      {laneName(group.laneId)} · {group.actor}
                    </small>
                  </span>
                  <span className="fx-faint">
                    save {group.saveIndex + 1}
                    <small title={group.at}>{age(group.at, now, true)}</small>
                  </span>
                  <span>
                    {group.paths.length} {group.paths.length === 1 ? 'file' : 'files'}
                  </span>
                </button>
              ))}
            </div>
            {groups.length > 5 && (
              <div className="fx-review-more">
                <Button variant="ghost" onClick={() => expand(!expanded)}>
                  {expanded ? 'Show fewer saves' : `${groups.length - 5} more saves`}
                </Button>
              </div>
            )}
            {!groups.length && (
              <p className="fx-review-empty">
                {data.reason ? (
                  <ErrorToast read error={data.reason} />
                ) : (
                  'No recorded save cohorts for this Candidate.'
                )}
              </p>
            )}
          </>
        )}
      </Panel>
      {(!data || data.files.total > 0) && children(current?.paths, current?.message ?? 'Candidate changes')}
    </>
  );
}
