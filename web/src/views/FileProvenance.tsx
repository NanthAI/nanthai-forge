import { ErrorToast } from '../ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { Button, DiffStat } from '../ui/primitives';
import { age } from '../ui/status';
import type { FileRow, ReadSource } from './model';
import { useViewRead } from './useRead';
export function FileProvenance({
  file,
  viewId,
  source,
  laneHref,
  intentHref,
  laneName,
  now,
  parentTitle,
}: {
  file: FileRow;
  viewId: string;
  source: ReadSource;
  laneHref: (id: string) => string;
  intentHref: (id: string) => string;
  laneName: (id: string) => string;
  now: number;
  parentTitle?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details className="fx-provenance-file" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>
        <code>{file.path}</code>
        <span className="fx-muted">{file.status}</span>
        <span
          className="fx-file-contributors"
          title={file.contributors?.map(c => laneName(c.laneId)).join(' + ')}
        >
          {file.contributors
            ? `${file.contributors.length} ${file.contributors.length === 1 ? 'Lane' : 'Lanes'} · ${file.contributors.reduce((n, c) => n + c.saves.length, 0)} ${file.contributors.reduce((n, c) => n + c.saves.length, 0) === 1 ? 'save' : 'saves'}`
            : ''}
        </span>
        {file.additions != null && file.deletions != null && (
          <DiffStat add={file.additions} del={file.deletions} />
        )}
      </summary>
      {open && <FileDetail {...{ file, viewId, source, laneHref, intentHref, laneName, now, parentTitle }} />}
    </details>
  );
}
function FileDetail({
  file,
  viewId,
  source,
  laneHref,
  intentHref,
  laneName,
  now,
  parentTitle,
}: Parameters<typeof FileProvenance>[0]) {
  const [lines, setLines] = useState(false);
  const { data, error, retry } = useViewRead(source, {
    action: 'provenance',
    viewId,
    file: file.path,
    ...(lines ? { lines: true } : {}),
  });
  const detail = data?.files.items[0];
  return (
    <div className="fx-provenance-detail" aria-busy={!data && !error}>
      {error ? (
        <ErrorToast error={error} retry={retry} />
      ) : !detail ? (
        <p className="fx-loading">Reading provenance…</p>
      ) : (
        <>
          <div>
            <h3>Saves that touched this file</h3>
            {detail.contributors?.map(c => (
              <div key={`${c.viewId}:${c.laneId}`}>
                <a href={laneHref(c.laneId)}>
                  <b>{laneName(c.laneId)}</b>
                </a>
                {c.saves.map(save => (
                  <div className="fx-provenance-save" key={`${save.saveIndex}:${save.head}`}>
                    <div>
                      <b>
                        {save.message !== parentTitle && save.message !== laneName(c.laneId)
                          ? save.message
                          : `Save ${save.saveIndex + 1}`}
                      </b>
                      <div className="fx-faint">
                        {save.actor?.name && save.actor.name !== 'Agent workflow' && (
                          <>{save.actor.name} · </>
                        )}
                        save {save.saveIndex + 1}
                      </div>
                    </div>
                    <time title={save.at}>{age(save.at, now, true)}</time>
                  </div>
                ))}
              </div>
            ))}
            {!detail.historyComplete && <p className="fx-muted">Save history incomplete.</p>}
          </div>
          <div>
            <h3>Why</h3>
            {detail.why
              ?.filter(why => why.outcome !== parentTitle || why.notes.length > 0)
              .map(why => (
                <div key={why.intentId}>
                  <a href={intentHref(why.intentId)}>
                    <b>{why.outcome === parentTitle ? 'Intent decisions' : (why.outcome ?? 'Intent')}</b>
                  </a>
                  {why.notes.map(note => (
                    <p key={note.id}>{note.excerpt}</p>
                  ))}
                </div>
              ))}
          </div>
          <div className="fx-provenance-lines">
            <Button size="sm" variant="ghost" onClick={() => setLines(!lines)}>
              {lines ? 'Hide line attribution' : 'Show line attribution'}
            </Button>
            {lines &&
              (detail.lines ? (
                detail.lines.status === 'unavailable' ? (
                  <ErrorToast error={detail.lines.reason} retry={retry} />
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>Lines</th>
                        <th>Lane and save</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.lines.ranges.map(range => (
                        <tr key={range.startLine}>
                          <td>
                            {range.startLine}–{range.endLine}
                          </td>
                          <td>
                            {range.source === 'base'
                              ? 'Base'
                              : range.source === 'unattributed'
                                ? 'Unattributed'
                                : range.attributions.map(a => (
                                    <a key={`${a.laneId}:${a.saveIndex}`} href={laneHref(a.laneId)}>
                                      {laneName(a.laneId)} @ save {a.saveIndex + 1}{' '}
                                    </a>
                                  ))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              ) : (
                <p className="fx-loading">Reading line attribution…</p>
              ))}
          </div>
        </>
      )}
    </div>
  );
}
