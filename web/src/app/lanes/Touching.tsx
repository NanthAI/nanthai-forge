// SPDX-License-Identifier: Apache-2.0
// Who is touching what (Item eb0bbb94): files saved in more than one Lane, who waits on whom and why, the landing
// queue in order with held Lanes apart, and who has what. Built only from the existing queue, hold and overlap
// records the Lanes place already reads; saved work only, so no row here ever proves two Lanes independent.
import { useMemo, type ReactNode } from 'react';
import { Avatar, Dock, Key, Region, State, useDockLayout, type DockLayout, type StateWord } from '../../ds';
import { A } from '../frames';
import { hrefFor } from '../paths';
import { Head, crumbsFor } from '../Place';
import type { LanesProps } from './common';
import { buildYard, sharedFiles, waits, type QueueEntry, type YardRow } from './model';
import { useLaneMeta, useQueue, useSharedFiles } from './reads';

const LAYOUT: DockLayout = { top: ['cross'], a: ['waits', 'queue'], b: ['has'] };
const CAP = 8;

const age = (from: string, now: number) => {
  const minutes = Math.max(0, Math.round((now - Date.parse(from)) / 60_000));
  return minutes < 60
    ? `${minutes} min`
    : minutes < 2880
      ? `${Math.round(minutes / 60)} h`
      : `${Math.round(minutes / 1440)} d`;
};

export function Touching({ route, projectId, projectName, feed }: LanesProps) {
  const { lanes } = useLaneMeta(projectId);
  const { queue, error: queueError } = useQueue(projectId);
  const shared = useSharedFiles(projectId, true);
  const [layout, setLayout, resetLayout] = useDockLayout('touching', LAYOUT);
  const now = Date.now();
  const yard = useMemo(
    () => (feed ? buildYard(feed, lanes ?? [], queue, Date.now()) : null),
    [feed, lanes, queue],
  );
  const rowOf = new Map<string, YardRow>(yard?.rows.map(row => [row.laneId, row]));
  const titleOf = (laneId: string) => rowOf.get(laneId)?.title ?? `Lane ${laneId.slice(0, 8)}`;
  const laneHref = (laneId: string) => hrefFor({ ...route, section: '', rest: laneId });
  const files = sharedFiles(shared.view);
  const pairs = waits(queue?.entries ?? [], titleOf);
  const onPerson = pairs.filter(pair => pair.person).length;
  const ordered = (queue?.entries ?? []).filter(entry => entry.position !== null);
  // Out of the order: held for a person, a dependency or main, and failed checks (every held Lane on the line).
  const held = (queue?.entries ?? []).filter(entry => entry.position === null);
  const lead = !shared.view
    ? 'Loading the Lanes…'
    : files.files.length
      ? `${files.files.length.toLocaleString()} ${files.files.length === 1 ? 'file is' : 'files are'} saved in more than one Lane.`
      : 'No two open Lanes have saved the same file.';
  const rest = queue
    ? `${onPerson ? `${onPerson.toLocaleString()} ${onPerson === 1 ? 'Lane waits' : 'Lanes wait'} on a person, ` : ''}${(pairs.length - onPerson).toLocaleString()} on another Lane or on main.`
    : '';
  const more = (n: number, words: string) =>
    n > 0 ? (
      <div className="pf">
        {n.toLocaleString()} {words}.{' '}
        <a
          className="lk"
          href={`/${encodeURIComponent(route.handle)}/${encodeURIComponent(route.project)}/lanes`}
        >
          Every open Lane
        </a>
      </div>
    ) : null;
  const regions = [
    {
      id: 'cross',
      title: 'Where Lanes cross',
      render: (handle: ReactNode) => (
        <Region
          title="Where Lanes cross"
          handle={handle}
          weight="watch"
          count={shared.view ? files.files.length : undefined}
          hint="saved work only: unsaved edits are not seen"
        >
          {shared.error ? (
            <p className="quietline">The overlaps could not be read.</p>
          ) : !shared.view ? (
            <div className="sk-rows" aria-busy="true" aria-label="Loading the overlaps">
              <div className="sk" />
            </div>
          ) : files.files.length ? (
            <ul className="lanes-files">
              {files.files.slice(0, CAP).map(file => (
                <li key={file.path} className="row">
                  <span className="lanes-path">
                    <State word="Set aside" state="stale">
                      Same file
                    </State>
                    <span className="mono any" translate="no" dir="ltr">
                      {file.path}
                    </span>
                  </span>
                  <span className="meta t2">
                    {file.laneIds.map((id, index) => (
                      <span key={id}>
                        {index ? (index === file.laneIds.length - 1 ? ' and ' : ', ') : ''}
                        <A className="lk" href={laneHref(id)} dir="auto">
                          {titleOf(id)}
                        </A>
                        {rowOf.get(id)?.overlap ? ' (conflict)' : ''}
                      </span>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="quietline">No two open Lanes have saved changes to the same file.</p>
          )}
          {more(files.files.length - CAP, 'more shared files')}
          {shared.view && !files.complete ? (
            <div className="pf">Some Lanes were not compared, so this list may be short.</div>
          ) : null}
        </Region>
      ),
    },
    {
      id: 'has',
      title: 'Who has what',
      render: (handle: ReactNode) => (
        <Region
          title="Who has what"
          handle={handle}
          weight="ref"
          count={yard?.rows.length}
          hint="open Lanes, latest change first"
        >
          {(yard?.rows ?? [])
            .slice()
            .sort((a, b) => b.changedAt - a.changedAt)
            .slice(0, 12)
            .map(row => (
              <A key={row.laneId} className="row lanes-has" href={laneHref(row.laneId)}>
                <Avatar handle={row.actor ?? '?'} />
                <span className="any">
                  <span className="ttl wrap2" dir="auto">
                    {row.title}
                  </span>
                  <span className="meta mono cut" translate="no">
                    {row.actor ?? 'not reported'}
                  </span>
                </span>
                <State word="Working" state={row.state}>
                  {row.word}
                </State>
              </A>
            ))}
          {more((yard?.rows.length ?? 0) - 12 + (yard?.beyond ?? 0), 'more open Lanes')}
        </Region>
      ),
    },
    {
      id: 'waits',
      title: 'Who waits on whom',
      render: (handle: ReactNode) => (
        <Region
          title="Who waits on whom"
          handle={handle}
          weight={onPerson ? 'act' : 'watch'}
          waiting={onPerson}
          count={queue ? pairs.length : undefined}
          hint="waits on a person first, longest first"
        >
          {queueError ? <p className="quietline">The landing queue could not be read.</p> : null}
          {queue && !pairs.length ? <p className="quietline">No Lane is waiting on another.</p> : null}
          {pairs.slice(0, CAP).map(pair => (
            <div key={pair.laneId} className="row lanes-wait">
              <span className="any">
                <A className="ttl" href={laneHref(pair.laneId)} dir="auto">
                  {titleOf(pair.laneId)}
                </A>{' '}
                <span className="t3">waits on</span>{' '}
                <span className="ttl" dir="auto">
                  {pair.on}
                </span>
                <span className="meta" style={{ display: 'block' }} dir="auto">
                  {pair.why || 'no reason was recorded'}
                  {pair.since ? ` · ${age(pair.since, now)}` : ''}
                </span>
              </span>
              {pair.person ? (
                <A className="btn sm rec" href={hrefFor({ ...route, place: 'needs', section: '', rest: '' })}>
                  Decide
                </A>
              ) : null}
            </div>
          ))}
          {more(pairs.length - CAP, 'more waits, none on a person')}
        </Region>
      ),
    },
    {
      id: 'queue',
      title: 'Landing queue',
      render: (handle: ReactNode) => (
        <Region
          title="Landing queue"
          handle={handle}
          weight="watch"
          count={queue ? queue.total : undefined}
          hint="in order, each checked on top of the one before"
        >
          {queue && !ordered.length ? <p className="quietline">Nothing is in the landing queue.</p> : null}
          {ordered.map(entry => (
            <QueueRow
              key={entry.laneId ?? entry.submittedAt}
              entry={entry}
              title={entry.laneId ? titleOf(entry.laneId) : (entry.intentTitle ?? 'A landing')}
              href={entry.laneId ? laneHref(entry.laneId) : null}
            />
          ))}
          {queue && queue.more ? <div className="pf">More are in the queue than are listed here.</div> : null}
          {held.length ? (
            <>
              <div className="band">
                <span>Held, out of the order</span>{' '}
                <span className="cnt">{held.length.toLocaleString()}</span>
              </div>
              {held.map(entry => (
                <QueueRow
                  key={entry.laneId ?? entry.submittedAt}
                  entry={entry}
                  title={entry.laneId ? titleOf(entry.laneId) : (entry.intentTitle ?? 'A landing')}
                  href={entry.laneId ? laneHref(entry.laneId) : null}
                />
              ))}
            </>
          ) : null}
        </Region>
      ),
    },
  ];
  const moved = JSON.stringify(layout) !== JSON.stringify(LAYOUT);
  return (
    <>
      <Head
        trail={crumbsFor(route, projectName)}
        sentence={
          <>
            <b>{lead}</b> {rest}
          </>
        }
      >
        <Key kind="ghost" size="sm" onClick={resetLayout} hidden={!moved}>
          Reset layout
        </Key>
      </Head>
      <Dock
        label="Who is touching what"
        regions={regions}
        layout={layout}
        onLayout={setLayout}
        onReset={resetLayout}
      />
    </>
  );
}

function QueueRow({ entry, title, href }: { entry: QueueEntry; title: string; href: string | null }) {
  const name = href ? (
    <A className="ttl cut" href={href} dir="auto">
      {title}
    </A>
  ) : (
    <span className="ttl cut" dir="auto">
      {title}
    </span>
  );
  const failed = !entry.hold && entry.position === null;
  const word: StateWord = failed
    ? 'Check failed'
    : entry.hold
      ? entry.hold.kind === 'review'
        ? 'Needs you'
        : 'Waiting its turn'
      : entry.phase === 'checking'
        ? 'Checking'
        : 'Waiting its turn';
  return (
    <div className="row lanes-q">
      <span className="qn" aria-label={entry.position ? `number ${entry.position}` : 'held'}>
        {entry.position ?? '–'}
      </span>
      <span className="any">
        {name}
        <span className="meta cut" style={{ display: 'block' }}>
          {entry.hold
            ? entry.hold.reason
            : failed
              ? (entry.lastFailingTests ?? []).join(', ') || entry.error || 'its check failed'
              : entry.position === 1
                ? 'lands next'
                : `behind ${entry.position! - 1}`}
        </span>
      </span>
      <State word={word} />
    </div>
  );
}
