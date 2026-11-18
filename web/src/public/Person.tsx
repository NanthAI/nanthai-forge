// SPDX-License-Identifier: Apache-2.0
// A person's page (Item 6a251b23): first and last activity, what they and their agent runs did per day, the runs they
// started, and where. Everything comes from the per-person day rows (convex/personDays.ts), filtered on the server for
// this viewer: a visitor reads the cached public JSON (no Convex connection); a signed-in viewer asks Convex once when
// the page opens (one query, never a live subscription), which adds private projects both people are in, or
// everything for the person themself. No polling, no timer.
import './person.css';
import { useEffect, useState, type ReactNode } from 'react';
import { useConvex } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { State, Who, initials } from '../ds';
import { whoLinks } from '../app/who-links';
import { followLink } from '../app/router';
import { hrefFor } from '../app/paths';
import type { LatestAction, ProfileRead } from '../../../src/person-days';
import type { ListedProject } from './read';
import { OwnDevices, Starred } from './PersonOwn';

const nf = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const big = (n: number) => (n >= 100_000 ? compact.format(n) : nf.format(n));
const plural = (n: number, one: string, many = `${one}s`) => `${nf.format(n)} ${n === 1 ? one : many}`;
const DAY = 86_400_000;
const utc = (iso: string) => Date.parse(`${iso}T00:00:00.000Z`);
const dateOf = (ms: number, year = false) =>
  new Date(ms).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: year ? 'numeric' : undefined,
    timeZone: 'UTC',
  });
function ago(ms: number, now: number) {
  const minutes = Math.floor((now - ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`;
  return dateOf(ms, new Date(ms).getUTCFullYear() !== new Date(now).getUTCFullYear());
}

/** What the days count (docs/people.md). */
const MEASURES = [
  { key: 'landings', at: 1, one: 'landing', many: 'landings', title: 'Landings' },
  { key: 'items', at: 5, one: 'Item closed', many: 'Items closed', title: 'Items closed' },
  { key: 'lanes', at: 2, one: 'Lane', many: 'Lanes', title: 'Lanes' },
  { key: 'reviews', at: 3, one: 'review', many: 'reviews', title: 'Reviews' },
] as const;
type Measure = (typeof MEASURES)[number];

type Load = { state: 'loading' } | { state: 'failed' } | { state: 'ok'; data: ProfileRead };

/** The signed-in read: asked once per page (and per agents page), never subscribed. */
function useProfile(handle: string, signedIn: boolean, agentsFrom: number): Load | null {
  const convex = useConvex();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    convex
      .query(api.personDays.profile, { handle, agentsFrom })
      .then(text => {
        const data = JSON.parse(text) as ProfileRead & { missing?: true; error?: unknown };
        if (live) setLoad(data.schema === 1 ? { state: 'ok', data } : { state: 'failed' });
      })
      .catch(() => live && setLoad({ state: 'failed' }));
    return () => {
      live = false;
    };
  }, [convex, handle, signedIn, agentsFrom]);
  return signedIn ? load : null;
}

export function Person({
  handle,
  signedIn,
  publicRead,
  projects,
  projectCount,
  rows,
}: {
  handle: string;
  signedIn: boolean;
  /** The cached public read's contributions (public projects only). */
  publicRead: ProfileRead | undefined;
  /** The public projects list, drawn by the discovery page. */
  projects: ReactNode;
  projectCount: number;
  /** Draws listed projects as the discovery page does (the person's own Starred list). */
  rows: (projects: readonly ListedProject[]) => ReactNode;
}) {
  const [agentsFrom, setAgentsFrom] = useState(0);
  const [asOthers, setAsOthers] = useState(false);
  const [measure, setMeasure] = useState<Measure>(MEASURES[0]);
  const signed = useProfile(handle, signedIn, agentsFrom);
  const [now] = useState(() => Date.now());
  const read = asOthers || !signed ? publicRead : signed.state === 'ok' ? signed.data : undefined;
  const self = !asOthers && read?.self === true;
  const pending = !asOthers && signed?.state === 'loading';
  const shown = read ?? publicRead;
  return (
    <>
      <div className="phead">
        <span className="av pro" aria-hidden="true">
          {initials(`@${handle}`)}
        </span>
        <div className="id">
          <h1 translate="no">
            <span dir="auto">@{handle}</span>
            {self ? <span className="kind">You</span> : null}
          </h1>
          <p className="fl">
            {shown?.first ? <span>First activity {dateOf(shown.first, true)}</span> : null}
            {shown?.last ? <span>Last activity {ago(shown.last, now)}</span> : null}
            {!shown?.first ? <span>{plural(projectCount, 'public project')}</span> : null}
          </p>
        </div>
        <div className="tools">
          {read?.self || asOthers ? (
            <button
              type="button"
              className="btn ghost"
              aria-pressed={asOthers}
              onClick={() => setAsOthers(v => !v)}
            >
              {asOthers ? 'See it as you do' : 'See it as others do'}
            </button>
          ) : null}
        </div>
      </div>
      {pending && !read ? (
        <p className="quietline" aria-busy="true">
          Loading contributions…
        </p>
      ) : signed?.state === 'failed' && !asOthers ? (
        <p className="quietline" role="status">
          Contributions could not be read. Showing public contributions.
        </p>
      ) : null}
      {shown ? (
        <Contributions
          read={shown}
          self={self}
          measure={measure}
          onMeasure={setMeasure}
          now={now}
          onAgents={!asOthers && signed?.state === 'ok' ? setAgentsFrom : undefined}
        />
      ) : null}
      {self ? <OwnDevices now={now} /> : null}
      {projects}
      {self ? <Starred now={now} rows={rows} /> : null}
    </>
  );
}

function scopeWords(read: ProfileRead, self: boolean) {
  if (self) return 'on every project';
  const shared = read.projects.filter(p => p.shared).length;
  return shared
    ? `on public projects and the ${plural(shared, 'one', 'ones')} you are both in`
    : 'on public projects';
}

function Contributions({
  read,
  self,
  measure,
  onMeasure,
  now,
  onAgents,
}: {
  read: ProfileRead;
  self: boolean;
  measure: Measure;
  onMeasure: (m: Measure) => void;
  now: number;
  onAgents: ((from: number) => void) | undefined;
}) {
  const scope = scopeWords(read, self);
  if (!read.days.length)
    return (
      <section className="region" aria-label="Contributions">
        <div className="empty">
          <h3>Nothing yet</h3>
          <p>
            {self
              ? 'What you and your agents land shows here, day by day.'
              : `No contributions ${scope} yet.`}
          </p>
          {self ? (
            <a className="btn" href={hrefFor({ frame: 'bare', page: 'import' })} onClick={followLink}>
              Import a repository
            </a>
          ) : null}
        </div>
      </section>
    );
  const total = (m: Measure) =>
    m.key === 'landings'
      ? read.totals.landings
      : m.key === 'items'
        ? (read.totals.itemsClosed ?? 0)
        : m.key === 'lanes'
          ? read.totals.lanes
          : read.totals.reviews;
  return (
    <>
      <section className="region" aria-label="Contributions">
        <div
          className="nums pick"
          role="group"
          aria-label={`Contributions ${scope}. Choose what the days count.`}
        >
          {MEASURES.map(m => (
            <button
              key={m.key}
              type="button"
              aria-pressed={m.key === measure.key}
              onClick={() => onMeasure(m)}
            >
              <b>
                {big(total(m))}
                {/* A busy day stopped counting planning work at a cap: the figure is a floor. */}
                {m.key === 'items' && read.closedPartial ? (
                  <span title="At least this many: older days are counted from what is still kept">+</span>
                ) : null}
              </b>
              <span>{total(m) === 1 ? m.one : m.many}</span>
            </button>
          ))}
        </div>
        <Days read={read} measure={measure} scope={scope} now={now} />
      </section>
      <Latest read={read} scope={scope} now={now} />
      <Agents read={read} scope={scope} onAgents={onAgents} />
      <Where read={read} self={self} />
    </>
  );
}

function Days({
  read,
  measure,
  scope,
  now,
}: {
  read: ProfileRead;
  measure: Measure;
  scope: string;
  now: number;
}) {
  const counts = new Map(read.days.map(d => [d[0], d[measure.at] ?? 0]));
  const end = utc(new Date(now).toISOString().slice(0, 10));
  // A new person gets a short grid from their first day; at most 53 weeks.
  const start = Math.max(utc(read.days[0]![0]), end - (53 * 7 - 1) * DAY);
  const n = Math.round((end - start) / DAY) + 1;
  const lead = (new Date(start).getUTCDay() + 6) % 7;
  const cols = Math.ceil((lead + n) / 7);
  let max = 0,
    top = start,
    none = 0,
    sum = 0;
  for (let i = 0; i < n; i++) {
    const v = counts.get(new Date(start + i * DAY).toISOString().slice(0, 10)) ?? 0;
    sum += v;
    if (v > max) {
      max = v;
      top = start + i * DAY;
    }
    if (!v) none++;
  }
  const columns: { cells: ReactNode[]; label: string }[] = [];
  let lastMonth = -1;
  for (let c = 0; c < cols; c++) {
    const cells: ReactNode[] = [];
    let label = '';
    for (let r = 0; r < 7; r++) {
      const i = c * 7 + r - lead;
      if (i < 0 || i >= n) {
        cells.push(<i key={r} className="x" />);
        continue;
      }
      const t = start + i * DAY,
        d = new Date(t),
        v = counts.get(d.toISOString().slice(0, 10)) ?? 0;
      if (d.getUTCMonth() !== lastMonth && (d.getUTCDate() <= 7 || lastMonth === -1)) {
        if (cols - c > 2 || lastMonth === -1)
          label = d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
        lastMonth = d.getUTCMonth();
      }
      cells.push(
        <i
          key={r}
          data-l={v && max ? Math.ceil((v / max) * 4) : 0}
          title={`${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}: ${plural(v, measure.one, measure.many)}`}
        />,
      );
    }
    columns.push({ cells, label });
  }
  // Month names need three columns: a partial first month gives way to the next month's start, and nothing is
  // named in the last two columns.
  let named = -1;
  columns.forEach((column, c) => {
    if (!column.label) return;
    if (named >= 0 && c - named < 3) {
      if (named === 0) columns[0]!.label = '';
      else return void (column.label = '');
    }
    named = c;
  });
  const weeks = columns.map((column, c) => (
    <div key={c} className={`cw${cols - c > 26 ? ' old' : ''}`}>
      {column.cells}
      {column.label ? <b>{column.label}</b> : null}
    </div>
  ));
  const byAgents =
    measure.key === 'reviews' || measure.key === 'items'
      ? null
      : measure.key === 'landings'
        ? [read.totals.landingsByAgents, read.totals.landings]
        : [read.totals.lanesByAgents, read.totals.lanes];
  return (
    <>
      <div className="ph plain">
        <h2>{measure.title} per day</h2>
        <span className="hint">
          {scope} · <span className="only-long">{plural(cols, 'week')}</span>
          <span className="only-short">{plural(Math.min(26, cols), 'week')}</span>
          {read.through ? ` · counted through ${dateOf(utc(read.through))}` : ''}
        </span>
      </div>
      <div className="days">
        <div
          className="cal"
          role="img"
          aria-label={`${measure.title} per day, ${dateOf(start, true)} to ${dateOf(end, true)}, ${scope}: ${nf.format(sum)} in all.${max ? ` The busiest day was ${dateOf(top)} with ${nf.format(max)}.` : ''} ${plural(none, 'day')} with none.`}
        >
          {weeks}
        </div>
        <dl className="kv">
          <dt>Busiest day</dt>
          <dd>
            {max ? (
              <>
                <span className="num">{nf.format(max)}</span>, on {dateOf(top)}
              </>
            ) : (
              'none yet'
            )}
          </dd>
          <dt>Days with any</dt>
          <dd>
            <span className="num">{nf.format(n - none)}</span> of {nf.format(n)}
          </dd>
          <dt>By agents</dt>
          <dd>
            {byAgents ? (
              byAgents[1] ? (
                <>
                  <span className="num">{Math.round((byAgents[0]! / byAgents[1]) * 100)}%</span> of these{' '}
                  {measure.many}
                </>
              ) : (
                'none yet'
              )
            ) : measure.key === 'items' ? (
              'an Item records who closed it, not which agent'
            ) : (
              'a review is a person’s'
            )}
          </dd>
        </dl>
      </div>
    </>
  );
}

function Agents({
  read,
  scope,
  onAgents,
}: {
  read: ProfileRead;
  scope: string;
  onAgents: ((from: number) => void) | undefined;
}) {
  const { total, from, rows } = read.agents;
  if (!total) return null;
  const day = (iso: string) => dateOf(utc(iso));
  return (
    <section className="region" aria-label="Agents">
      <div className="ph plain">
        <h2>Agents</h2>
        <span className="cnt">{big(total)}</span>
        <span className="hint">
          runs @{read.handle} started, {scope} · newest first
        </span>
      </div>
      <div className="th trow agt">
        <span>Agent run and its model</span>
        <span className="r">Lanes</span>
        <span className="r">Landings</span>
        <span>First day</span>
        <span>Last day</span>
      </div>
      {rows.map(agent => {
        const by = `${read.handle}/${agent.run}`;
        return (
          <div key={`${agent.project.handle}/${agent.project.slug}/${agent.run}`} className="row trow agt">
            <Who
              handle={by}
              model={agent.model ?? ''}
              layout="line"
              size="md"
              nofor
              {...whoLinks(by, { handle: agent.project.handle, project: agent.project.slug })}
            />
            <span className="c num r">
              {nf.format(agent.lanes)}
              <span className="k"> {agent.lanes === 1 ? 'Lane' : 'Lanes'}</span>
            </span>
            <span className="c num r">
              {nf.format(agent.landings)}
              <span className="k"> landed</span>
            </span>
            <span className="c">
              <span className="k">first </span>
              {day(agent.first)}
            </span>
            <span className="c">
              <span className="k">last </span>
              {day(agent.last)}
            </span>
          </div>
        );
      })}
      <div className="pager">
        <span className="n">
          {nf.format(from + 1)} to {nf.format(from + rows.length)} of {nf.format(total)}
        </span>
        {onAgents ? (
          <>
            <button
              type="button"
              className="btn sm"
              disabled={from === 0}
              onClick={() => onAgents(Math.max(0, from - 25))}
            >
              Newer
            </button>
            <button
              type="button"
              className="btn sm"
              disabled={from + rows.length >= total}
              onClick={() => onAgents(from + 25)}
            >
              Older
            </button>
          </>
        ) : total > rows.length ? (
          <span>Sign in to page through the rest.</span>
        ) : null}
      </div>
    </section>
  );
}

function Where({ read, self }: { read: ProfileRead; self: boolean }) {
  if (!read.projects.length) return null;
  const vis = (p: ProfileRead['projects'][number]) =>
    p.visibility === 'public' ? 'Public' : p.shared && !self ? 'Private, you are both in it' : 'Private';
  return (
    <section className="region" aria-label="Where">
      <div className="ph plain">
        <h2>Where</h2>
        <span className="cnt">{read.projects.length}</span>
        <span className="hint">
          {self ? 'every project you worked on' : 'projects you can open'}
          {read.projectsLeftOut ? ` · ${plural(read.projectsLeftOut, 'older project')} not shown` : ''}
        </span>
      </div>
      <div className="th trow proj">
        <span>Project</span>
        <span className="r">Landings</span>
        <span className="r">Items closed</span>
        <span className="r">Lanes</span>
        <span className="r">Reviews</span>
        <span>Last activity</span>
      </div>
      {read.projects.map(p => {
        const id = `${p.handle}/${p.slug}`;
        return (
          <div key={id} className="row trow proj">
            <div className="pn">
              <a
                className="mono"
                href={hrefFor({
                  frame: 'project',
                  handle: p.handle,
                  project: p.slug,
                  place: 'needs',
                  section: '',
                  rest: '',
                })}
                onClick={followLink}
                dir="auto"
                translate="no"
                title={id}
              >
                {id}
              </a>
              <span className="meta">{vis(p)}</span>
            </div>
            <span className="c num r">
              {big(p.landings)}
              <span className="k"> landed</span>
            </span>
            <span className="c num r">
              {big(p.closed ?? 0)}
              <span className="k"> Items closed</span>
            </span>
            <span className="c num r">
              {big(p.lanes)}
              <span className="k"> Lanes</span>
            </span>
            <span className="c num r">
              {big(p.reviews)}
              <span className="k"> reviews</span>
            </span>
            <span className="c">
              <span className="k">last </span>
              {dateOf(p.last)}
            </span>
          </div>
        );
      })}
    </section>
  );
}

const clock = (ms: number, now: number) =>
  new Date(ms).toISOString().slice(0, 10) === new Date(now).toISOString().slice(0, 10)
    ? new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })
    : dateOf(ms);

/** The newest few actions in projects the viewer may open (convex/personWork.ts latestActions). */
function Latest({ read, scope, now }: { read: ProfileRead; scope: string; now: number }) {
  const rows = read.latest ?? [];
  if (!rows.length) return null;
  const href = (row: LatestAction) =>
    hrefFor({
      frame: 'project',
      handle: row.project.handle,
      project: row.project.slug,
      place: row.kind === 'landed' ? 'code' : row.kind === 'lane' ? 'lanes' : 'plan',
      section: '',
      rest: row.target,
    });
  return (
    <section className="region" aria-label="Latest">
      <div className="ph plain">
        <h2>Latest</h2>
        <span className="hint">{scope}</span>
      </div>
      {rows.map(row => {
        const by = row.run ? `${read.handle}/${row.run}` : `@${read.handle}`;
        const where = { handle: row.project.handle, project: row.project.slug };
        return (
          <div key={`${row.kind}:${row.target}:${row.at}`} className="row latest">
            <span className="num" title={new Date(row.at).toISOString()}>
              {clock(row.at, now)}
            </span>
            <div className="what">
              <a className="ttl" href={href(row)} onClick={followLink} dir="auto">
                {row.title}
              </a>
              <Who
                handle={by}
                {...(row.run && row.model !== null ? { model: row.model } : {})}
                layout="line"
                nofor
                {...whoLinks(by, row.run ? where : undefined)}
              />
              <span className="meta" translate="no">
                {row.project.handle}/{row.project.slug}
              </span>
            </div>
            {row.kind === 'comment' ? (
              <span className="tag t3">Commented</span>
            ) : (
              <State word={row.kind === 'landed' ? 'Landed' : 'In progress'} />
            )}
          </div>
        );
      })}
    </section>
  );
}
