// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Key, Region } from '../../ds';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { PlanRow } from '../../../../src/planning-model';
import { useItemDiscussion } from '../discussion/ItemDiscussion';
import type { DiscussionComment } from '../discussion/model';
import type { WhoProject } from '../who-links';
import { ItemBody } from './ItemBody';
import { useItemEdits, type EditItemPorts } from './item-edit';
import type { FullItem } from './batch';
import './item-page.css';

export type ReadItem = (id: string, full?: boolean) => Promise<FullItem | null>;
type Props = {
  row: PlanRow;
  read?: ReadItem | undefined;
  aside: ReactNode;
  onItem: (item: FullItem) => void;
  projectId?: Id<'hostedProjects'> | undefined;
  project: WhoProject;
  href: (itemId: string) => string;
  edit?: EditItemPorts | undefined;
};
const none: readonly DiscussionComment[] = [];

export default function ItemDetail(props: Props) {
  return props.projectId ? (
    <WithDiscussion {...props} projectId={props.projectId} />
  ) : (
    <Detail {...props} comments={none} />
  );
}

function WithDiscussion(props: Props & { projectId: Id<'hostedProjects'> }) {
  const discussion = useItemDiscussion({
    projectId: props.projectId,
    itemId: props.row.id,
    project: props.project,
  });
  return <Detail {...props} {...discussion} />;
}

function Detail({
  row,
  read,
  aside,
  onItem,
  comments,
  discussion,
  edit,
  href,
}: Props & {
  comments: readonly DiscussionComment[];
  discussion?: ReactNode;
}) {
  const [item, setItem] = useState<FullItem>();
  const [failed, setFailed] = useState(false);
  const [deferred, setDeferred] = useState(false);
  const [loading, setLoading] = useState(false);
  const observed = useRef<{ id: string; version: number | undefined; read: ReadItem } | undefined>(undefined);
  const request = useRef<Promise<FullItem | null> | undefined>(undefined);
  const load = useCallback(
    async (full = false) => {
      if (!read) throw new Error('Item text is unavailable.');
      setFailed(false);
      setLoading(true);
      const pending = read(row.id, full);
      request.current = pending;
      try {
        const value = await pending;
        if (request.current === pending) {
          setDeferred(value === null);
          setItem(value ?? undefined);
          if (value) onItem(value);
        }
        return value;
      } catch (error) {
        if (request.current === pending) setFailed(true);
        throw error;
      } finally {
        if (request.current === pending) setLoading(false);
      }
    },
    [read, row.id, onItem],
  );
  const retry = () => void load().catch(() => undefined);
  useEffect(() => {
    const last = observed.current;
    if (!read || (last?.read === read && last.id === row.id && last.version === row.version)) return;
    observed.current = { id: row.id, version: row.version, read };
    retry();
  }, [read, load, row.id, row.version]);
  const edits = useItemEdits(edit, async () => {
    const value = await load(true);
    if (!value) throw new Error('Item text is unavailable.');
    return value;
  });
  const visible = item ?? edits.draft?.base;
  return (
    <div className="ip-cols">
      <div className="ip-main">
        {visible ? (
          <ItemBody item={visible} comments={comments} edits={edits} href={href} />
        ) : read ? (
          <Region title="Text">
            <div className="quietline ip-reserve" role="status">
              {deferred ? (
                <>
                  {failed
                    ? 'Text could not be loaded.'
                    : 'The Item has more text than can be loaded on open.'}{' '}
                  <Key size="sm" disabled={loading} onClick={() => void load(true).catch(() => undefined)}>
                    {loading ? 'Loading…' : 'Show all text'}
                  </Key>
                </>
              ) : failed ? (
                <>
                  Text could not be loaded.{' '}
                  <Key size="sm" onClick={retry}>
                    Retry
                  </Key>
                </>
              ) : (
                'Loading the Item text…'
              )}
            </div>
          </Region>
        ) : null}
        {failed && item ? (
          <div className="quietline" role="status">
            Text could not be refreshed.{' '}
            <Key size="sm" onClick={retry}>
              Retry
            </Key>
          </div>
        ) : null}
      </div>
      <div className="ip-side">{aside}</div>
      {discussion ? <div className="ip-com">{discussion}</div> : null}
    </div>
  );
}
