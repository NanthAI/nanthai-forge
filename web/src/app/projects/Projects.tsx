// SPDX-License-Identifier: Apache-2.0
// Account > Projects (Item 3d5d8839): every project the person owns or is a member of, newest activity first. One
// bounded read per visit (convex/accountProjects.ts, 50 rows a page; "Show more" reads the next page by its cursor),
// read again when the tab comes back into view. It is a one-off read, not a subscription: nothing re-runs on landings,
// no polling, nothing while the tab is idle or hidden.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConvex } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import { Band, Key, Region, Row, State } from '../../ds';
import { A } from '../frames';
import { hrefFor } from '../paths';
import { Head } from '../Place';
import type { AccountProps } from '../screen-route';
import {
  grouped,
  heldWords,
  itemWords,
  laneWords,
  metaWords,
  sentence,
  type AccountRead,
  type ProjectRow,
} from './model';
import './projects.css';

const PAGE = 50;
type Read =
  | { state: 'loading' }
  | { state: 'failed'; last?: AccountRead }
  | { state: 'ok'; data: AccountRead };

/** The first page once per visit and again when the tab is shown after being hidden; more pages by cursor. */
function useAccountProjects() {
  const client = useConvex();
  const [read, setRead] = useState<Read>({ state: 'loading' });
  const last = useRef<AccountRead | undefined>(undefined);
  const cursor = useRef<string | null>(null);
  const page = useCallback(
    (from: string | null) => {
      void client
        .query(api.accountProjects.list, { paginationOpts: { cursor: from, numItems: PAGE } })
        .then(result => {
          const data = {
            projects: [...(from && last.current ? last.current.projects : []), ...result.page],
            more: !result.isDone,
          };
          cursor.current = result.isDone ? null : result.continueCursor;
          last.current = data;
          setRead({ state: 'ok', data });
        })
        .catch(() => setRead({ state: 'failed', last: last.current }));
    },
    [client],
  );
  const first = useCallback(() => page(null), [page]);
  useEffect(() => {
    first();
    const shown = () => {
      if (document.visibilityState === 'visible') first();
    };
    document.addEventListener('visibilitychange', shown);
    return () => document.removeEventListener('visibilitychange', shown);
  }, [first]);
  return { read, retry: first, showMore: () => cursor.current && page(cursor.current) };
}

export default function Projects(_props: AccountProps) {
  const { read, retry, showMore } = useAccountProjects();
  return <ProjectsView read={read} retry={retry} showMore={showMore} now={Date.now()} />;
}

const trail = [
  { label: 'Account', href: hrefFor({ frame: 'account', place: 'projects' }) },
  { label: 'Projects' },
];
const startHref = hrefFor({ frame: 'bare', page: 'new' });
const importHref = hrefFor({ frame: 'bare', page: 'import' });

export function ProjectsView({
  read,
  retry,
  showMore,
  now,
}: {
  read: Read;
  retry: () => void;
  showMore?: () => void;
  now: number;
}) {
  const data = read.state === 'ok' ? read.data : read.state === 'failed' ? read.last : undefined;
  const groups = useMemo(() => (data ? grouped(data.projects) : null), [data]);
  const tools = (
    <>
      <A className="btn sm" href={startHref}>
        Start a project
      </A>
      <A className="btn sm" href={importHref}>
        Import a repository
      </A>
    </>
  );
  if (!data)
    return (
      <div className="account-projects">
        <Head
          trail={trail}
          sentence={read.state === 'failed' ? 'Your projects could not be read.' : 'Loading…'}
        >
          {tools}
        </Head>
        {read.state === 'failed' ? (
          <Notice retry={retry} />
        ) : (
          <div className="sk-rows" aria-busy="true" aria-label="Loading your projects">
            <div className="sk" />
            <div className="sk" />
            <div className="sk" />
          </div>
        )}
      </div>
    );
  if (!data.projects.length)
    return (
      <div className="account-projects">
        <Head trail={trail} sentence="No projects yet." />
        {read.state === 'failed' ? <Notice retry={retry} /> : null}
        <div className="empty">
          <h2>Your projects will appear here</h2>
          <p>Start one for your agents, or bring a repository you already have.</p>
          <div className="btns">
            <A className="btn primary" href={startHref}>
              Start a project
            </A>
            <A className="btn" href={importHref}>
              Import a repository
            </A>
          </div>
        </div>
      </div>
    );
  const shown = data.projects.length;
  return (
    <div className="account-projects">
      <Head trail={trail} sentence={sentence(data)}>
        {tools}
      </Head>
      {read.state === 'failed' ? <Notice retry={retry} /> : null}
      <Region
        title="Your projects"
        weight={groups!.needs.length ? 'act' : 'watch'}
        waiting={groups!.needs.length}
        count={shown}
        hint={data.more ? `${shown.toLocaleString()} shown, newest activity first` : 'newest activity first'}
      >
        {groups!.needs.length ? (
          <>
            <Band title="Needs you" count={groups!.needs.length} needs hint="a Lane is held for a person" />
            {groups!.needs.map(row => (
              <ProjectLine key={row.id} row={row} now={now} needs />
            ))}
            {groups!.rest.length ? <Band title="Everything else" count={groups!.rest.length} /> : null}
          </>
        ) : null}
        {groups!.rest.map(row => (
          <ProjectLine key={row.id} row={row} now={now} />
        ))}
        {data.more ? (
          <div className="quietline proj-more">
            <span>{shown.toLocaleString()} shown; you have more projects.</span>
            {showMore ? (
              <Key size="sm" onClick={showMore}>
                Show {PAGE.toLocaleString()} more
              </Key>
            ) : null}
          </div>
        ) : null}
      </Region>
    </div>
  );
}

function Notice({ retry }: { retry: () => void }) {
  return (
    <div className="notice" role="status">
      <span>Your projects could not be read just now. What was last shown stays here.</span>
      <Key size="sm" onClick={retry}>
        Retry
      </Key>
    </div>
  );
}

function ProjectLine({ row, now, needs }: { row: ProjectRow; now: number; needs?: boolean }) {
  const href =
    row.handle && row.slug
      ? hrefFor({
          frame: 'project',
          handle: row.handle,
          project: row.slug,
          place: 'needs',
          section: '',
          rest: '',
        })
      : null;
  return (
    <Row className="proj" weight={needs ? 'act' : 'watch'} cols="minmax(0, 1fr) auto">
      <span className="proj-name">
        {href ? (
          <A className="ttl" href={href} dir="auto" translate="no">
            {row.name}
          </A>
        ) : (
          <span className="ttl" dir="auto" translate="no">
            {row.name}
          </span>
        )}
        <span className="meta">
          {row.handle && row.slug ? (
            <span className="mono" translate="no">
              {row.handle}/{row.slug}
            </span>
          ) : null}
          <span>{metaWords(row, now)}</span>
        </span>
      </span>
      <span className="proj-facts">
        {row.held.n ? <State word="Needs you">{heldWords(row)}</State> : null}
        <span>{laneWords(row)}</span>
        <span>{itemWords(row)}</span>
      </span>
    </Row>
  );
}
