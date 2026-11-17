// SPDX-License-Identifier: Apache-2.0
// To read (Item 9e748e41, its To read part): what landed that you have not read, newest first, with bulk mark-read.
// Read state is per account (convex/projectLandingReads.ts), so every device and the CLI agree. It never holds a
// landing and never counts toward Needs you; held work only points to Needs me.
import { useState, type KeyboardEvent } from 'react';
import { Avatar, Band, Key, Region } from '../../ds';
import { A } from '../frames';
import { hrefFor } from '../paths';
import { Head, crumbsFor } from '../Place';
import type { LanesProps } from './common';
import { groupByDay } from './model';
import { useLandings, useMarkRead, useQueue, type Landed } from './reads';

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

type Done = { words: string; undo: () => void } | null;

export function ToRead({ route, projectId, projectName }: LanesProps) {
  const { page, error } = useLandings(projectId, 'unread');
  const { queue } = useQueue(projectId);
  const mark = useMarkRead();
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [done, setDone] = useState<Done>(null);
  const [failed, setFailed] = useState('');
  const rows = page?.rows ?? [];
  const approvals = (queue?.entries ?? []).filter(entry => entry.hold?.kind === 'review').length;
  const needsMe = hrefFor({ ...route, place: 'needs', section: '', rest: '' });
  const n = rows.length;
  const count = `${n.toLocaleString()}${page?.more ? ' or more' : ''}`;
  type Mark = Parameters<typeof mark>[0];
  const run = (args: Mark, words: string, undo?: Mark) => {
    setFailed('');
    void mark(args)
      .then(reply => {
        const { previous } = JSON.parse(reply) as { previous: { through: number; read: number[] } };
        setSelected(new Set());
        const back = undo ?? { projectId, restoreThrough: previous.through, read: previous.read };
        setDone({ words, undo: () => void mark(back).then(() => setDone(null)) });
      })
      .catch(() => setFailed('Could not mark them read. Nothing changed; try again.'));
  };
  const markSelected = () => {
    const sequences = [...selected];
    if (!sequences.length) return;
    run({ projectId, read: sequences }, `Marked ${sequences.length.toLocaleString()} as read.`, {
      projectId,
      unread: sequences,
    });
  };
  const markAll = () => {
    if (page?.newest === null || page?.newest === undefined) return;
    run({ projectId, through: page.newest }, 'Marked everything as read.');
  };
  const toggle = (sequence: number) =>
    setSelected(was => {
      const next = new Set(was);
      if (next.has(sequence)) next.delete(sequence);
      else next.add(sequence);
      return next;
    });
  const onKey = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if ((event.target as HTMLElement).closest('input, textarea')) return;
    if (event.key === 'e' && selected.size) {
      event.preventDefault();
      markSelected();
    } else if (event.key === 'Escape' && selected.size) setSelected(new Set());
  };
  const lead = !page ? 'Loading what landed…' : n ? `${count} to read.` : 'Nothing to read.';
  const rest = !page
    ? ''
    : n
      ? `${page.started ? 'Landed since you last marked what you read' : 'The newest landings'}, newest first.`
      : page.newest === null
        ? 'Nothing has landed in this project yet.'
        : 'You have read or marked everything that landed.';
  return (
    <>
      <Head
        trail={crumbsFor(route, projectName)}
        sentence={
          <>
            <b>{lead}</b> {rest}
            {approvals ? (
              <>
                {' '}
                <A className="lk lanes-inline" href={needsMe}>
                  {approvals.toLocaleString()} {approvals === 1 ? 'Lane waits' : 'Lanes wait'} for your
                  approval
                </A>{' '}
                in Needs me.
              </>
            ) : null}
          </>
        }
      >
        {n ? (
          <Key size="sm" onClick={markAll}>
            Mark all as read
          </Key>
        ) : null}
      </Head>
      <div role="status" aria-live="polite" className="lanes-status">
        {done ? (
          <div className="notice" data-st="passed">
            <p>{done.words}</p>
            <Key size="sm" onClick={done.undo}>
              Undo
            </Key>
          </div>
        ) : failed ? (
          <div className="notice" data-st="failed">
            <p>{failed}</p>
          </div>
        ) : null}
      </div>
      {error ? (
        <div className="notice" data-st="failed" role="alert">
          <p>What landed could not be read. Your agents and the queue are not affected.</p>
        </div>
      ) : null}
      {!page ? (
        <Region title="To read">
          <div className="sk-rows" aria-busy="true" aria-label="Loading what there is to read">
            <div className="sk" />
            <div className="sk" />
            <div className="sk" />
          </div>
        </Region>
      ) : n ? (
        <div onKeyDown={onKey}>
          <Region title="To read" count={n} hint="newest first">
            {selected.size ? (
              <div className="bulk">
                <b>{selected.size.toLocaleString()} selected</b>
                <Key size="sm" keys="e" onClick={markSelected}>
                  Mark as read
                </Key>
                <Key size="sm" kind="ghost" keys="Esc" onClick={() => setSelected(new Set())}>
                  Clear
                </Key>
              </div>
            ) : null}
            {groupByDay(rows, new Date().toDateString()).map(group => (
              <div key={group.title} role="list" aria-label={group.title}>
                <Band title={group.title} count={group.rows.length} />
                {group.rows.map(row => (
                  <ReadRow
                    key={row.receiptId}
                    row={row}
                    on={selected.has(row.sequence)}
                    toggle={() => toggle(row.sequence)}
                    href={row.laneId ? hrefFor({ ...route, section: '', rest: row.laneId }) : null}
                  />
                ))}
              </div>
            ))}
            <div className="pf">
              {page.more ? 'Only the newest 30 are listed; marking them read shows the rest. ' : null}
              Kept per account, so your other devices agree.
            </div>
          </Region>
        </div>
      ) : (
        <Region title="To read" quiet>
          {page.newest === null ? (
            <div className="empty">
              <h3>What lands shows here until you read it</h3>
              <p>Nothing here ever holds a landing.</p>
              <A className="btn" href={hrefFor({ ...route, section: '', rest: '' })}>
                See the open Lanes
              </A>
            </div>
          ) : (
            <p className="quietline">
              Nothing to read.{' '}
              <A className="lk" href={hrefFor({ ...route, place: 'code', section: '', rest: '' })}>
                The code on main
              </A>
            </p>
          )}
        </Region>
      )}
    </>
  );
}

function ReadRow({
  row,
  on,
  toggle,
  href,
}: {
  row: Landed;
  on: boolean;
  toggle: () => void;
  href: string | null;
}) {
  const title = row.title ?? 'Untitled landing';
  return (
    <div role="listitem" className={on ? 'row rv sel' : 'row rv'}>
      <label className="ckhit">
        <input
          type="checkbox"
          className="ckb"
          checked={on}
          onChange={toggle}
          aria-label={`Select ${title}`}
        />
      </label>
      <Avatar handle={row.actor ?? '?'} />
      <span className="any">
        {href ? (
          <A className="ttl wrap2" dir="auto" href={href}>
            {title}
          </A>
        ) : (
          <span className="ttl wrap2" dir="auto">
            {title}
          </span>
        )}
        <span className="meta cut">
          <span className="mono" translate="no">
            {row.actor ?? 'not reported'}
          </span>
          , {row.automatic ? 'landed by project policy' : 'accepted by a person'}
        </span>
      </span>
      <span className="num t2 when">{time(row.at)}</span>
    </div>
  );
}
