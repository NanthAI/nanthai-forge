import { usePageCritical } from '../ui/page-critical';
import { ErrorToast } from '../ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { Button, Panel, StatusPill } from '../ui/primitives';

import type { ViewReadModel } from '../../../src/view-read-model';
import { viewStatus, type ReadSource } from './model';
import { useViewRead } from './useRead';
import './views.css';
export function LaneViews({
  laneId,
  intentHref,
  viewHref,
  source,
  viewNumber,
}: {
  laneId: string;
  intentHref: string;
  viewHref: (id: string) => string;
  source: ReadSource;
  viewNumber?: (id: string) => number | undefined;
}) {
  const { data, error, retry } = useViewRead(source, { action: 'views', laneId });
  usePageCritical('Lane', { viewLinks: data !== undefined || !!error });
  const [pages, setPages] = useState<{
    items: ViewReadModel[];
    cursor?: string | null;
    offset?: number | null;
  }>();
  const [busy, setBusy] = useState(false),
    [pageError, setPageError] = useState('');
  useEffect(() => setPages(undefined), [laneId, source, data]);
  const items = [...(data?.items ?? []), ...(pages?.items ?? [])];
  const [earlierOpen, setEarlierOpen] = useState(false);
  const earlier = items.filter(view => view.status === 'superseded' && !view.accepted.length);
  const visible = items.filter(view => !earlier.includes(view) || earlierOpen);
  const cursor = pages ? pages.cursor : data?.nextCursor,
    offset = pages ? pages.offset : data?.nextOffset;
  const more = async () => {
    setBusy(true);
    try {
      const next = await source({
        action: 'views',
        laneId,
        ...(cursor ? { cursor } : {}),
        ...(offset != null ? { offset } : {}),
      });
      setPages({
        items: [...(pages?.items ?? []), ...(next.items ?? [])],
        cursor: next.nextCursor,
        offset: next.nextOffset,
      });
    } catch (e) {
      setPageError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (data && !items.length && !error) return null;
  return (
    <Panel
      title="Part of these Views"
      count={data ? items.length : undefined}
      actions={<a href={intentHref}>Work map</a>}
    >
      <div className="fx-lane-views" aria-busy={!data && !error}>
        {error || pageError ? (
          <ErrorToast error={error || pageError} retry={error ? retry : more} />
        ) : !data ? (
          <p className="fx-loading">Reading Views…</p>
        ) : !items.length ? (
          <p className="fx-panel-note">No Views yet</p>
        ) : (
          <ul className="fx-view-links">
            {visible.map(view => {
              const input = view.inputs.find(input => input.laneId === laneId),
                [tone, label] = viewStatus(view);
              return (
                <li key={view.viewId}>
                  <div>
                    <a href={viewHref(view.viewId)}>
                      <b>View {viewNumber?.(view.viewId) ?? ''}</b>
                    </a>{' '}
                    <StatusPill tone={tone}>{label}</StatusPill>
                  </div>
                  <div className="fx-faint">
                    this Lane @{' '}
                    {input && input.saveIndex >= 0 ? `save ${input.saveIndex + 1}` : 'saved source'} ·{' '}
                    {view.inputs.length} {view.inputs.length === 1 ? 'Lane' : 'Lanes'}
                    {view.accepted.length > 0 &&
                      ` · landed on ${view.accepted.map(a => a.channel).join(', ')}`}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {earlier.length > 0 && (
          <Button variant="ghost" aria-expanded={earlierOpen} onClick={() => setEarlierOpen(!earlierOpen)}>
            {earlierOpen ? 'Hide earlier' : `${earlier.length} earlier`}
          </Button>
        )}
        {(cursor || offset != null) && (
          <Button disabled={busy} onClick={() => void more()}>
            More Views
          </Button>
        )}
      </div>
    </Panel>
  );
}
