// SPDX-License-Identifier: Apache-2.0
// Needs me › Loose ends (Item fc1831eb), as the approved forge-design-p7/flow/loose-ends.html: what was started and
// left, in five groups from one details read (projectLooseEnds:read, details: true) at route entry. Each group lists
// its rows with their evidence, or says why it is not reported; dated checks link to their Item; a group with more
// asks for its next page with the returned cursor, one call per press. The owner picks Lanes nobody holds and sets
// them aside through the existing dormant sweep, which re-checks each Lane: one that gained a save meanwhile is skipped
// and named, and retry repeats only the calls that failed. Nothing here deletes. Loaded with its section only.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useConvex, useMutation } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import { ConvexError } from 'convex/values';
import type { Id } from '../../../../convex/_generated/dataModel';
import { useSafeQuery } from '../../safe-query';
import { Key, State, Who } from '../../ds';
import { Announcer, useAnnounce } from '../../ds/behaviour/announce';
import { A } from '../frames';
import { hrefFor } from '../paths';
import { Head, crumbsFor } from '../Place';
import type { PlaceProps } from '../screens';
import {
  looseEndsScreen,
  mergePage,
  setAsideWord,
  type GroupKey,
  type LooseEndsRead,
  type Pages,
} from './loose-ends';
import './needs.css';

type ReadArgs = { projectId: Id<'hostedProjects'>; details?: true; cursor?: string };
const looseRead = makeFunctionReference<'query', ReadArgs, string>('projectLooseEnds:read');
const abandon = makeFunctionReference<
  'mutation',
  { projectId: Id<'hostedProjects'>; authorityEpoch: number; abandon: string[] },
  string
>('projectHostedDormant:abandon');
/** The sweep takes at most this many Lanes per call (projectHostedDormant DORMANT_BATCH). */
const BATCH = 25;
const AGENT_READ = `nforge agent . lanes '{"view":"loose-ends"}'`;

export default function LooseEnds({ route, projectId, projectName }: PlaceProps) {
  const convex = useConvex();
  // Try again drops the failed subscription for one render and subscribes again: the client keeps a failed
  // result while it is subscribed, so a one-shot read of the same arguments would return that same failure.
  const [dropped, setDropped] = useState(false);
  useEffect(() => {
    if (dropped) setDropped(false);
  }, [dropped]);
  const live = useSafeQuery(looseRead, dropped ? 'skip' : { projectId, details: true });
  const last = useRef<string>(undefined);
  if (live.value !== undefined) last.current = live.value;
  const raw = live.value ?? last.current;
  const read = useMemo(() => (raw === undefined ? undefined : (JSON.parse(raw) as LooseEndsRead)), [raw]);
  const setAside = useMutation(abandon);
  return (
    <LooseEndsView
      trail={crumbsFor(route, projectName)}
      read={read}
      failed={!!live.error}
      retry={() => setDropped(true)}
      page={cursor => convex.query(looseRead, { projectId, cursor })}
      setAside={(epoch, ids) => setAside({ projectId, authorityEpoch: epoch, abandon: ids })}
      itemHref={itemId => hrefFor({ ...route, place: 'plan', section: '', rest: itemId })}
    />
  );
}

/** A refused cursor (the Plan changed, or the group moved on) restarts that group from the live first page. */
const restarts = (error: unknown) =>
  error instanceof ConvexError &&
  ['WORK_STALE', 'BAD_ARGUMENT'].includes((error.data as { code?: string } | undefined)?.code ?? '');

export function LooseEndsView({
  trail,
  read,
  failed,
  retry,
  page,
  setAside,
  itemHref,
}: {
  trail: Parameters<typeof Head>[0]['trail'];
  read: LooseEndsRead | undefined;
  failed: boolean;
  retry: () => void;
  page: (cursor: string) => Promise<string>;
  setAside: (authorityEpoch: number, laneIds: string[]) => Promise<string>;
  itemHref: (itemId: string) => string;
}) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [outcome, setOutcome] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [pages, setPages] = useState<Pages>({});
  const [paging, setPaging] = useState<Partial<Record<GroupKey, 'loading' | 'failed'>>>({});
  /** Titles of the Lanes submitted, so a Lane the live read drops meanwhile is still named in the notice. */
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [lastDone, setLastDone] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [cli, setCli] = useState(false);
  const [message, announce] = useAnnounce();
  useEffect(() => {
    if (!picked.size) return;
    const clear = (event: KeyboardEvent) => event.key === 'Escape' && setPicked(new Set());
    document.addEventListener('keydown', clear);
    return () => document.removeEventListener('keydown', clear);
  }, [picked.size]);
  const head = (sentence: ReactNode) => (
    <Head trail={trail} sentence={sentence}>
      <button
        type="button"
        className="cli mono"
        aria-controls="loose-cli"
        aria-expanded={cli}
        onClick={() => setCli(!cli)}
      >
        <span>{AGENT_READ}</span>
      </button>
    </Head>
  );
  const cliOut = cli ? (
    <pre className="cli-out mono" id="loose-cli" tabIndex={0}>
      <b>$ {AGENT_READ}</b>
      {'\n'}# The same five groups: rows with their evidence, a continueCursor, or why a group is not
      reported.
      {'\n'}# Pass a group’s continueCursor as "cursor" for its next page. Setting aside keeps every save.
    </pre>
  ) : null;
  const tryAgain = () => {
    retry();
    announce('Reading loose ends again.');
  };
  const notice = failed ? (
    <div className="notice" data-st="failed" role="alert">
      <State word="Check failed">Could not load</State>
      <p>
        Forge could not read the list. Nothing was set aside or moved.
        {read
          ? ` The rows below are from ${new Date(read.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.`
          : ''}
      </p>
      <Key size="sm" kind="rec" onClick={() => void tryAgain()}>
        Try again
      </Key>
    </div>
  ) : null;
  if (!read)
    return (
      <div className="needs-me loose-ends">
        {head(failed ? 'Loose ends could not be read.' : 'Looking for loose ends…')}
        {notice}
        {failed ? null : (
          <section className="region" aria-busy="true" aria-label="Loading loose ends">
            {[38, 82, 64, 74, 52, 68].map(width => (
              <div key={width} className="skrow" style={{ ['--w' as string]: width }}>
                <div className="sk" />
                <div className="sk" />
              </div>
            ))}
          </section>
        )}
      </div>
    );
  const screen = looseEndsScreen(read, pages, read.at);
  const idle = screen.sections.find(section => section.key === 'idle');
  const open = (laneId: string) => outcome[laneId] !== 'abandoned';
  const pickable = idle?.pickable ? idle.rows.filter(row => open(row.key)).map(row => row.key) : [];
  const selected = pickable.filter(id => picked.has(id));
  const failedIds = Object.keys(outcome).filter(id => outcome[id] === 'failed');
  const toggle = (ids: string[], on: boolean) =>
    setPicked(old => {
      const next = new Set(old);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  const setAsideNow = async (ids: string[]) => {
    if (!read.setAside || !ids.length) return;
    setBusy(true);
    const named = new Map(
      screen.sections.flatMap(section =>
        section.rows.flatMap(row => (row.laneId ? [[row.laneId, row.title] as const] : [])),
      ),
    );
    setTitles(old => ({
      ...old,
      ...Object.fromEntries(ids.flatMap(id => (named.has(id) ? [[id, named.get(id)!]] : []))),
    }));
    setDismissed(old => new Set([...old].filter(id => !ids.includes(id))));
    const results: Record<string, string> = {};
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      try {
        const reply = JSON.parse(await setAside(read.setAside.authorityEpoch, batch)) as {
          results: { laneId: string; result: string }[];
        };
        for (const entry of reply.results) results[entry.laneId] = entry.result;
      } catch {
        for (const id of batch) results[id] = 'failed';
      }
    }
    setOutcome(old => ({ ...old, ...results }));
    toggle(ids, false);
    setBusy(false);
    const done = ids.filter(id => results[id] === 'abandoned').length;
    setLastDone(done);
    announce(
      `${done.toLocaleString('en')} set aside${ids.length - done ? `, ${(ids.length - done).toLocaleString('en')} left alone, each named in the list` : ''}. Every save is kept.`,
    );
  };
  const more = async (key: GroupKey, cursor: string) => {
    setPaging(old => ({ ...old, [key]: 'loading' }));
    try {
      const reply = JSON.parse(await page(cursor)) as LooseEndsRead;
      const group = reply.groups[key];
      setPages(old => mergePage(old, key, reply));
      setPaging(old => ({ ...old, [key]: undefined }));
      const n = group?.reported ? group.rows.length : 0;
      announce(
        n
          ? `${n.toLocaleString('en')} more shown.`
          : group?.reported && group.continueCursor
            ? 'That page had none; more remain.'
            : 'No more.',
      );
    } catch (error) {
      if (restarts(error)) {
        // The cursor no longer fits the live read: start this group again from its live first page.
        setPages(old => {
          const next = { ...old };
          delete next[key];
          return next;
        });
        setPaging(old => ({ ...old, [key]: undefined }));
        announce('That list changed meanwhile; it starts again from its newest first page.');
        return;
      }
      setPaging(old => ({ ...old, [key]: 'failed' }));
      announce('Could not load more. Nothing changed.');
    }
  };
  // Every Lane left alone stays named here, even when the live read no longer lists it; a failed one keeps its retry.
  const leftAlone = Object.keys(outcome).filter(
    id => outcome[id] !== 'abandoned' && (outcome[id] === 'failed' || !dismissed.has(id)),
  );
  const skippedIds = leftAlone.filter(id => outcome[id] !== 'failed');
  const named = leftAlone.slice(0, 5).map(id => {
    const word = setAsideWord(outcome[id]!);
    return `“${titles[id] ?? `Lane ${id.slice(0, 8)}`}” ${word.retry ? 'could not be reached' : word.word.replace(/^Skipped: /, 'skipped: ')}`;
  });
  return (
    <div className="needs-me loose-ends">
      {head(
        <>
          <b>{screen.sentence.bold}</b> {screen.sentence.rest}
        </>,
      )}
      {cliOut}
      {notice}
      {leftAlone.length ? (
        <div className="notice" data-st="waiting" role="alert">
          <State word="Needs you">{leftAlone.length.toLocaleString('en')} could not be set aside</State>
          <p>
            {lastDone === null
              ? ''
              : `${lastDone.toLocaleString('en')} ${lastDone === 1 ? 'Lane was' : 'Lanes were'} set aside in your last try. `}
            {named.join('; ')}
            {leftAlone.length > named.length
              ? `; and ${(leftAlone.length - named.length).toLocaleString('en')} more`
              : ''}
            . Every save is kept.
          </p>
          {failedIds.length ? (
            <Key size="sm" kind="rec" disabled={busy} onClick={() => void setAsideNow(failedIds)}>
              Retry {failedIds.length.toLocaleString('en')} that failed
            </Key>
          ) : null}
          {skippedIds.length ? (
            <Key size="sm" onClick={() => setDismissed(old => new Set([...old, ...skippedIds]))}>
              See what is left
            </Key>
          ) : null}
        </div>
      ) : null}
      <section className="region" aria-label="Loose ends">
        {selected.length ? (
          <div className="bulk" role="region" aria-label="Selected">
            <b className="num">{selected.length.toLocaleString('en')} selected</b>
            <span className="grow" />
            <Key size="sm" kind="rec" disabled={busy} onClick={() => void setAsideNow(selected)}>
              Set aside {selected.length.toLocaleString('en')}
            </Key>
            <Key
              size="sm"
              kind="ghost"
              keys="Esc"
              aria-label="Clear the selection"
              onClick={() => setPicked(new Set())}
            >
              Clear
            </Key>
          </div>
        ) : null}
        {screen.total === 0 && screen.exhausted ? (
          <div className="quietline">
            No loose ends. Forge looks again whenever a Lane or a project changes, not on a timer.
          </div>
        ) : null}
        {screen.sections.map(section => {
          if (section.reported && !section.rows.length && !section.cursor && !section.why) return null;
          const shown = section.pickable ? section.rows.filter(row => open(row.key)).map(row => row.key) : [];
          const on = shown.filter(id => picked.has(id)).length;
          const state = section.key === 'active' ? undefined : paging[section.key];
          return (
            <div className="le-group" key={section.key} role="group" aria-label={section.title}>
              <div className="band">
                {shown.length ? (
                  <label className="ckhit">
                    <GroupTick
                      all={on === shown.length}
                      some={on > 0 && on < shown.length}
                      label={`Select the ${shown.length.toLocaleString('en')} shown in ${section.title}`}
                      onChange={value => toggle(shown, value)}
                    />
                  </label>
                ) : null}
                <span>{section.title}</span>
                {section.reported ? (
                  <span className="cnt num">
                    {section.rows.length.toLocaleString('en')}
                    {section.cursor ? '+' : ''}
                  </span>
                ) : null}
                <span className="hint">{section.hint}</span>
              </div>
              {section.why ? (
                <div className="quietline">
                  {section.reported ? section.why : `Not reported. ${section.why}`}
                </div>
              ) : null}
              {section.rows.map(row => {
                const word = outcome[row.key] ? setAsideWord(outcome[row.key]!) : null;
                const canPick = section.pickable && !word?.done;
                return (
                  <div
                    key={row.key}
                    className={`row le${section.rows.length > 20 ? ' dense' : ''}${picked.has(row.key) ? ' sel' : ''}`}
                  >
                    {canPick ? (
                      <label className="ckhit">
                        <input
                          type="checkbox"
                          className="ckb"
                          checked={picked.has(row.key)}
                          onChange={event => toggle([row.key], event.target.checked)}
                          aria-label={`Select ${row.title}`}
                        />
                      </label>
                    ) : (
                      <span />
                    )}
                    <div className="le-what">
                      <div className={`ttl wrap2${row.mono ? ' mono' : ''}`} dir="auto" title={row.title}>
                        {row.title}
                      </div>
                      {row.who ? (
                        <div className="meta">
                          <Who handle={row.who} />
                        </div>
                      ) : null}
                    </div>
                    <span className="meta any" dir="auto">
                      {row.evidence}
                    </span>
                    <span className="meta r num">{row.age}</span>
                    <span className="r">
                      {word ? (
                        <State word={word.done ? 'Set aside' : word.retry ? 'Check failed' : 'Not seen'}>
                          {word.word}
                        </State>
                      ) : row.itemId ? (
                        <A className="btn sm ghost" href={itemHref(row.itemId)}>
                          Open the Item
                        </A>
                      ) : canPick ? (
                        <Key size="sm" disabled={busy} onClick={() => void setAsideNow([row.key])}>
                          Set aside
                        </Key>
                      ) : null}
                    </span>
                  </div>
                );
              })}
              {section.cursor && section.key !== 'active' ? (
                <div className="le-more">
                  <span>
                    {state === 'failed'
                      ? 'Could not load the next page. Nothing changed.'
                      : 'More than these'}
                  </span>
                  <Key
                    size="sm"
                    disabled={state === 'loading'}
                    onClick={() => void more(section.key as GroupKey, section.cursor!)}
                  >
                    {state === 'failed' ? 'Try again' : state === 'loading' ? 'Loading…' : 'Show 25 more'}
                  </Key>
                </div>
              ) : null}
            </div>
          );
        })}
        <div className="pf">
          A loose end leaves this list when someone saves to it, lands it or sets it aside.
        </div>
      </section>
      <Announcer message={message} />
    </div>
  );
}

/** A group's tick: on when every shown row is picked, mixed when some are. */
function GroupTick({
  all,
  some,
  label,
  onChange,
}: {
  all: boolean;
  some: boolean;
  label: string;
  onChange: (on: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = some;
  }, [some]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="ckb"
      checked={all}
      aria-checked={some ? 'mixed' : all}
      onChange={event => onChange(event.target.checked)}
      aria-label={label}
    />
  );
}
