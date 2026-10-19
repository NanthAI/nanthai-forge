import { Breadcrumbs } from '../shell/Breadcrumbs';
import { ErrorToast } from '../ui/Toast';
import { ObjectActions } from '../shell/ObjectActions';
// SPDX-License-Identifier: Apache-2.0
import { useState, type ReactNode } from 'react';
import { ChangeMapToggle, type MapSource } from '../lane/ChangeMapToggle';
import { Glyph } from '../ui/Glyph';
import { Button, ButtonLink, DiffStat, ExactRecord, Panel, StatusPill } from '../ui/primitives';
import { age } from '../ui/status';
import { useNow } from '../shell/StatusBar';
import { FileProvenance } from './FileProvenance';
import { WorkMap } from './WorkMap';
import { useViewRead } from './useRead';
import { viewStatus, type ReadSource, type FileRow } from './model';
import './views.css';
export function ViewPage({
  viewId,
  source,
  laneHref,
  intentHref,
  viewHref,
  reviewHref,
  laneName = () => 'Lane',
  viewNumber,
  mapContext,
  conversation,
}: {
  conversation?: (data: NonNullable<ReturnType<typeof useViewRead>['data']>) => ReactNode;
  viewId: string;
  source: ReadSource;
  laneHref: (id: string) => string;
  intentHref: (id: string) => string;
  viewHref: (id: string) => string;
  reviewHref?: (id: string, intentId: string) => string;
  laneName?: (id: string) => string;
  mapContext?: Pick<MapSource, 'projectId' | 'backupId' | 'peers'>;
  viewNumber?: (id: string) => number | undefined;
}) {
  const now = useNow();
  const [mapSelected, setMapSelected] = useState('');
  const { data, error, retry } = useViewRead(source, { action: 'view', viewId });
  const provenance = useViewRead(source, { action: 'provenance', viewId });
  const [extra, setExtra] = useState<{
    viewId: string;
    files: FileRow[];
    cursor?: string | null;
    offset?: number | null;
  }>();
  const [busy, setBusy] = useState(false),
    [pageError, setPageError] = useState('');
  if (!data)
    return (
      <div className="fx-page fx-view-page">
        <h1>
          <Glyph name="view" /> View
        </h1>
        <div className="fx-view-placeholder" aria-busy={!error}>
          {error ? (
            <ErrorToast>
              {error} <Button onClick={retry}>Retry</Button>
            </ErrorToast>
          ) : (
            <p className="fx-loading">Reading View…</p>
          )}
        </div>
      </div>
    );
  const run = [...(data.runs ?? [])]
      .sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''))
      .at(-1),
    [tone, label] = viewStatus(data, run?.status);
  const name =
    data.inputs
      .map(
        input => `${laneName(input.laneId)}${input.saveIndex >= 0 ? ` · save ${input.saveIndex + 1}` : ''}`,
      )
      .join(' + ') || 'View';
  const inputName = laneName;
  const added = extra?.viewId === viewId ? extra : undefined;
  const metadata = new Map(provenance.data?.files.items.map(file => [file.path, file]));
  const files = [...data.files.items, ...(added?.files ?? [])].map(file => ({
    ...metadata.get(file.path),
    ...file,
  }));
  const cursor = added ? added.cursor : data.files.nextCursor,
    offset = added ? added.offset : data.files.nextOffset;
  const more = async () => {
    setBusy(true);
    setPageError('');
    try {
      const incoming: FileRow[] = [];
      let nextCursor = cursor,
        nextOffset = offset;
      do {
        const page = await source({
          action: 'view',
          viewId,
          ...(nextCursor ? { cursor: nextCursor } : {}),
          ...(nextOffset != null ? { offset: nextOffset } : {}),
        });
        incoming.push(...page.files.items);
        nextCursor = page.files.nextCursor;
        nextOffset = page.files.nextOffset;
      } while (nextCursor || nextOffset != null);
      setExtra({ viewId, files: [...(added?.files ?? []), ...incoming], cursor: null, offset: null });
    } catch (e) {
      setPageError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fx-page fx-view-page">
      <Breadcrumbs
        items={[
          { label: data.why.outcome ?? 'Intent', href: intentHref(data.intentId) },
          ...data.inputs.map(input => ({ label: laneName(input.laneId), href: laneHref(input.laneId) })),
          { label: `View${viewNumber?.(viewId) ? ` ${viewNumber(viewId)}` : ''}`, href: viewHref(viewId) },
        ]}
      />
      <div className="fx-lane-head">
        <div className="fx-lane-head-main">
          <h1>
            <Glyph name="view" /> {name} <StatusPill tone={tone}>{label}</StatusPill>
          </h1>
          <div className="fx-lane-meta">
            <span>
              {data.inputs.length} {data.inputs.length === 1 ? 'Lane' : 'Lanes'}
            </span>
            <span>
              {data.files.total} changed {data.files.total === 1 ? 'file' : 'files'}
            </span>
            <span title={data.at}>composed {age(data.at, now, true)}</span>
          </div>
        </div>
        <div className="fx-lane-head-actions">
          <ObjectActions head={data.head ?? undefined} />
          <ButtonLink variant="ghost" href={intentHref(data.intentId)}>
            Work map
          </ButtonLink>
          {data.status === 'ready' && reviewHref && (
            <ButtonLink variant="primary" href={reviewHref(viewId, data.intentId)}>
              Review &amp; accept
            </ButtonLink>
          )}
        </div>
      </div>
      <WorkMap
        now={now}
        title="Composition"
        compact
        lanes={data.inputs.map(input => ({
          id: input.laneId,
          name: inputName(input.laneId),
          checkpoints: Math.max(0, input.saveIndex + 1),
          accepted: data.status === 'accepted',
        }))}
        views={[
          {
            id: viewId,
            number: viewNumber?.(viewId),
            at: data.at,
            status: data.sourceStatus,
            lanes: '',
            inputs: data.inputs,
            accepted: data.status === 'accepted',
            supersededBy: data.supersededBy,
          },
        ]}
        laneHref={laneHref}
        viewHref={viewHref}
      />
      <div className="fx-lane-grid">
        <div className="fx-lane-col">
          <Panel title="Changed files" count={data.files.total}>
            {!data.head && (
              <p className="fx-panel-note">{data.files.unavailable ?? 'No composed file version.'}</p>
            )}
            {data.head && (
              <ChangeMapToggle
                source={{
                  ...mapContext,
                  kind: 'view',
                  id: viewId,
                  base: data.base,
                  head: data.head,
                  exclude: data.inputs.map(i => i.laneId),
                }}
                selected={mapSelected}
                select={path => setMapSelected(path)}
                showDiff
              >
                <div className="fx-view-files">
                  <ViewFiles
                    files={files}
                    grouped={data.files.total > 50}
                    render={file => (
                      <FileProvenance
                        key={file.path}
                        {...{ file, viewId, source, laneHref, intentHref, now }}
                        laneName={inputName}
                        parentTitle={data.why.outcome ?? undefined}
                      />
                    )}
                  />
                  {!files.length && (
                    <p className="fx-panel-note">{data.files.unavailable ?? 'No changed files'}</p>
                  )}
                </div>
                {(cursor || offset != null) && (
                  <Button
                    className="fx-view-more"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void more()}
                  >
                    {busy
                      ? 'Reading files…'
                      : `Show ${data.files.total - files.length} more ${data.files.total - files.length === 1 ? 'file' : 'files'}`}
                  </Button>
                )}
                {pageError && <ErrorToast>{pageError}</ErrorToast>}
              </ChangeMapToggle>
            )}
          </Panel>
        </div>
        <aside className="fx-lane-col">
          <Panel title="Record">
            <div className="fx-view-gates">
              <StatusPill tone={data.sourceStatus === 'conflict' ? 'conflict' : 'passed'}>
                {data.sourceStatus === 'conflict' ? 'Composition conflicted' : 'Composed cleanly'}
              </StatusPill>
              {data.runs?.map(check => (
                <div key={check.id}>
                  <StatusPill tone={viewStatus(data, check.status)[0]}>
                    {check.check?.name ?? check.checkName ?? 'Check'} · {check.status}
                  </StatusPill>
                </div>
              ))}
              {data.accepted.map(move => (
                <p key={move.id}>
                  ✓ Accepted into <b>{move.channel}</b>
                  <br />
                  <span className="fx-muted">
                    {(typeof move.actor === 'string' ? move.actor : move.actor?.name) &&
                      (typeof move.actor === 'string' ? move.actor : move.actor?.name) !==
                        'Agent workflow' && (
                        <>{typeof move.actor === 'string' ? move.actor : move.actor?.name} · </>
                      )}
                    <time title={move.at}>{age(move.at, now, true)}</time>
                  </span>
                </p>
              ))}
            </div>
            <ExactRecord
              rows={[
                ['View', viewId],
                ['Base', data.base],
                ['Head', data.head ?? undefined],
              ]}
            />
          </Panel>
          {(data.supersededBy || data.dependencies.some(d => d.kind === 'view')) && (
            <Panel title="Dependencies">
              <ul className="fx-view-links">
                {data.supersededBy && (
                  <li>
                    <a href={viewHref(data.supersededBy)}>
                      Superseded by View {viewNumber?.(data.supersededBy) ?? ''}
                    </a>
                  </li>
                )}
                {data.dependencies.map(
                  d =>
                    d.kind === 'view' && (
                      <li key={d.viewId}>
                        <a href={viewHref(d.viewId)}>View {viewNumber?.(d.viewId) ?? ''}</a>
                      </li>
                    ),
                )}
              </ul>
            </Panel>
          )}
          {conversation?.(data)}
        </aside>
      </div>
    </div>
  );
}

function ViewFiles({
  files,
  grouped,
  render,
}: {
  files: FileRow[];
  grouped: boolean;
  render: (file: FileRow) => ReactNode;
}) {
  if (!grouped) return <>{files.map(render)}</>;
  const folders = new Map<string, FileRow[]>();
  for (const file of files) {
    const folder = file.path.includes('/') ? `${file.path.split('/')[0]}/` : 'Root files';
    folders.set(folder, [...(folders.get(folder) ?? []), file]);
  }
  return (
    <>
      {[...folders].map(([folder, items]) => (
        <details className="fx-file-folder" key={folder}>
          <summary>
            <code>{folder}</code>
            <span className="fx-faint">
              {items.length} {items.length === 1 ? 'file' : 'files'}
            </span>
            {items.every(file => file.additions != null && file.deletions != null) && (
              <DiffStat
                add={items.reduce((n, file) => n + file.additions!, 0)}
                del={items.reduce((n, file) => n + file.deletions!, 0)}
              />
            )}
          </summary>
          {items.map(render)}
        </details>
      ))}
    </>
  );
}
