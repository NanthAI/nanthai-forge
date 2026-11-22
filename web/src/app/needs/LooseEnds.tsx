// SPDX-License-Identifier: Apache-2.0
// Needs me › Loose ends (Item fc1831eb), as the approved forge-design-p7/flow/loose-ends.html: what was started and
// left, in five groups from one details read (projectLooseEnds:read, details: true) at route entry. Each group lists
// its rows with their evidence, or says why it is not reported; a group with more asks for its next page with the
// returned cursor, one call per press. The owner picks rows with a tick per row and per group: Lanes nobody holds are
// set aside through the existing dormant sweep, Lanes are handed to an agent with one copied prompt (the existing
// explicit takeover; nothing is sent), and the owner's leftover projects move to the existing trash (restorable for
// 90 days). A row that changed meanwhile is skipped and named, retry replays only the exact requests that failed, and
// Undo brings back what the last action changed. The project this page belongs to is not trashed from here (the page
// would close with its Undo). Nothing here deletes. Loaded with its section only.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useConvex, useMutation } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import { ConvexError } from 'convex/values';
import type { Id } from '../../../../convex/_generated/dataModel';
import { useSafeQuery } from '../../safe-query';
import { Avatar, Key, State } from '../../ds';
import { Announcer, useAnnounce } from '../../ds/behaviour/announce';
import { A } from '../frames';
import { hrefFor } from '../paths';
import { Head, crumbsFor } from '../Place';
import type { PlaceProps } from '../screens';
import {
  handText,
  looseEndsScreen,
  mergePage,
  setAsideWord,
  trashWord,
  type GroupKey,
  type LooseEndsRead,
  type Pages,
  type ScreenRow,
  type Section,
} from './loose-ends';
import {
  bringBackLanes,
  restoreProjects,
  setAsideLanes,
  trashProjects,
  type Lifecycle,
  type LifecycleArgs,
  type Sweep,
  type TrashResult,
} from './loose-actions';
import { INTENT_CURSOR, intentWord, type IntentReopen, type IntentTidy } from './loose-intents';
import { useIntentTidy } from './use-intent-tidy';
import { ResultNotice, ResultToast, type LeftAlone, type Toast } from './LooseResult';
import './needs.css';

type ReadArgs = { projectId: Id<'hostedProjects'>; details?: true; cursor?: string };
const looseRead = makeFunctionReference<'query', ReadArgs, string>('projectLooseEnds:read');
type SweepCall = Parameters<Sweep>[0] & { projectId: Id<'hostedProjects'> };
const abandon = makeFunctionReference<'mutation', SweepCall, string>('projectHostedDormant:abandon');
type LifecycleCall = {
  projectId: Id<'hostedProjects'>;
  operationId: string;
  expectedRevision: number;
  expectedLastLanding?: string | null;
};
const trashRef = makeFunctionReference<'mutation', LifecycleCall, { applied: boolean } | null>(
  'projectLifecycle:trash',
);
const restoreRef = makeFunctionReference<'mutation', LifecycleCall, unknown>('projectLifecycle:restore');
type IntentCall = { projectId: Id<'hostedProjects'>; operationId: string; request: string };
const tidyRef = makeFunctionReference<'mutation', IntentCall, string>('projectLooseEndIntents:setAside');
const transitionRef = makeFunctionReference<
  'mutation',
  { projectId: Id<'hostedProjects'>; request: string },
  string
>('projectHostedLifecycle:transition');
/** Select all reads at most this many 25-row pages of one group (1,000 Lanes) before it stops and says more remain. */
const SELECT_ALL_PAGES = 40;
const AGENT_READ = `nforge agent . lanes '{"view":"loose-ends"}'`;

export default function LooseEnds({ route, projectId, projectName, viewerHandle }: PlaceProps) {
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
  const sweep = useMutation(abandon);
  const trash = useMutation(trashRef);
  const restore = useMutation(restoreRef);
  const tidy = useMutation(tidyRef);
  const reopen = useMutation(transitionRef);
  const asProject = (args: LifecycleArgs) => ({ ...args, projectId: args.projectId as Id<'hostedProjects'> });
  return (
    <LooseEndsView
      trail={crumbsFor(route, projectName)}
      read={read}
      failed={!!live.error}
      retry={() => setDropped(true)}
      page={cursor => convex.query(looseRead, { projectId, cursor })}
      sweep={args => sweep({ projectId, ...args })}
      trash={args => trash(asProject(args))}
      restore={args => restore(asProject(args))}
      tidy={args => tidy({ projectId, ...args })}
      reopen={args => reopen({ projectId, ...args })}
      copy={text => navigator.clipboard.writeText(text)}
      itemHref={itemId => hrefFor({ ...route, place: 'plan', section: '', rest: itemId })}
      viewer={viewerHandle}
      project={{ name: projectName, projectId, backend: convex.url }}
    />
  );
}

/** A refused cursor (the Plan changed, or the group moved on) restarts that group from the live first page. */
const restarts = (error: unknown) =>
  error instanceof ConvexError &&
  ['WORK_STALE', 'BAD_ARGUMENT'].includes((error.data as { code?: string } | undefined)?.code ?? '');
const count = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en')} ${n === 1 ? one : many}`;

export function LooseEndsView({
  trail,
  read,
  failed,
  retry,
  page,
  sweep,
  trash,
  restore,
  tidy,
  reopen,
  copy,
  itemHref,
  viewer,
  project,
}: {
  trail: Parameters<typeof Head>[0]['trail'];
  read: LooseEndsRead | undefined;
  failed: boolean;
  retry: () => void;
  page: (cursor: string) => Promise<string>;
  sweep: Sweep;
  trash: Lifecycle;
  restore: Lifecycle;
  /** Open Intents: one batch of up to 25 per call, and one reopen per Undo row. */
  tidy: IntentTidy;
  reopen: IntentReopen;
  copy: (text: string) => Promise<void>;
  itemHref: (itemId: string) => string;
  viewer?: string | undefined;
  /** The project this page belongs to: named in the hand-over prompt, and not trashed from here. */
  project: { name: string; projectId: string; backend: string };
}) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  /** Per-row results of the actions so far: Lanes (set aside, brought back) and projects (trash, restored). */
  const [outcome, setOutcome] = useState<Record<string, string>>({});
  const [trashed, setTrashed] = useState<Record<string, TrashResult | 'restored'>>({});
  const [busy, setBusy] = useState(false);
  const [pages, setPages] = useState<Pages>({});
  const [paging, setPaging] = useState<Partial<Record<GroupKey, 'loading' | 'failed'>>>({});
  const [selecting, setSelecting] = useState(false);
  /** Bumped by every Clear and Esc: a Select all still reading pages when it moves on must not repick. */
  const clears = useRef(0);
  /** Titles of the rows submitted, so a row the live read drops meanwhile is still named in the notice. */
  const [titles, setTitles] = useState<Record<string, string>>({});
  /** What the last action changed, for its Undo; and how many it changed. */
  const [undoLanes, setUndoLanes] = useState<{ laneId: string; version: number }[]>([]);
  const [undoProjects, setUndoProjects] = useState<LifecycleArgs[]>([]);
  const [lastDone, setLastDone] = useState<{ lanes: number | null; projects: number | null }>({
    lanes: null,
    projects: null,
  });
  /** The rows the last action (with its retries) submitted, plus earlier rows whose call failed: the notice speaks only
   * of these, so an older skip is not repeated and an older failure keeps its Retry. */
  const [lastLanes, setLastLanes] = useState<readonly string[]>([]);
  const [lastProjects, setLastProjects] = useState<readonly string[]>([]);
  /** The exact trash requests that failed, replayed as they were (same operation id and pins) by Retry. */
  const [projectRetry, setProjectRetry] = useState<LifecycleArgs[]>([]);
  /** See what is left: the notice names every row left alone, not only the first five. */
  const [seeAll, setSeeAll] = useState({ lanes: false, projects: false });
  const [toast, setToast] = useState<Toast | null>(null);
  const [cli, setCli] = useState(false);
  const [message, announce] = useAnnounce();
  const endToast = useCallback(() => setToast(null), []);
  useEffect(() => {
    if (!picked.size) return;
    const clear = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      clears.current++;
      setPicked(new Set());
    };
    document.addEventListener('keydown', clear);
    return () => document.removeEventListener('keydown', clear);
  }, [picked.size]);
  const toggle = (ids: string[], on: boolean) =>
    setPicked(old => {
      const next = new Set(old);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  const remember = (rows: ScreenRow[]) => {
    setTitles(old => ({ ...old, ...Object.fromEntries(rows.map(row => [row.key, row.title])) }));
    toggle(
      rows.map(row => row.key),
      false,
    );
    setToast(null);
  };
  const intents = useIntentTidy({
    epoch: read?.setAside?.authorityEpoch,
    tidy,
    reopen,
    outcome,
    setOutcome,
    setBusy,
    announce,
    setToast,
    remember,
  });
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
  const screen = looseEndsScreen(read, pages, read.at, viewer);
  const here = (row: ScreenRow) => !!row.trash && row.key === project.projectId;
  // One rule for the row tick, the group tick and the bulk bar: a row with a pending result is handled by its notice.
  const eligible = (row: ScreenRow) =>
    row.pickable &&
    !here(row) &&
    // A reopened Intent carries a version the reopen moved on: it is picked again only after a fresh read.
    (!outcome[row.key] || (outcome[row.key] === 'reopened' && !row.intent)) &&
    (!trashed[row.key] || trashed[row.key] === 'restored');
  const pickable = screen.sections.flatMap(section =>
    section.rows.filter(row => eligible(row) && picked.has(row.key)),
  );
  const pickedIdle = pickable.filter(row => row.action === 'set-aside');
  const pickedIntents = pickable.filter(row => row.action === 'tidy');
  const pickedLanes = pickable.filter(row => row.laneId);
  const pickedProjects = pickable.filter(row => row.trash);
  const allRows = () => screen.sections.flatMap(section => section.rows);
  // Select all: the owner's Lanes nobody holds, every page of the group (the existing page read, one call per page).
  const idle = screen.sections.find(section => section.key === 'idle' && section.reported);
  const idleEligible = idle && read.setAside ? idle.rows.filter(eligible).map(row => row.key) : [];
  const idleOn = idleEligible.filter(id => picked.has(id)).length;
  const selectAll = async () => {
    if (!idle) return;
    setSelecting(true);
    const started = clears.current;
    const ids = new Set(idleEligible);
    let cursor = idle.cursor;
    for (let n = 0; cursor && n < SELECT_ALL_PAGES; n++) {
      try {
        const reply = JSON.parse(await page(cursor)) as LooseEndsRead;
        setPages(old => mergePage(old, 'idle', reply));
        const group = reply.groups.idle;
        if (!group?.reported) break;
        for (const row of group.rows) ids.add(row.laneId);
        cursor = group.continueCursor ?? null;
      } catch {
        announce('Could not load every Lane. The Lanes loaded so far are selected.');
        break;
      }
    }
    setSelecting(false);
    if (clears.current !== started) return;
    toggle([...ids], true);
    announce(
      `${ids.size.toLocaleString('en')} Lanes nobody holds selected${cursor ? '; more remain, use Select all again' : ''}.`,
    );
  };

  /** Set Lanes aside. A retry (only the ids that failed) keeps the Undo pins of the rows that already succeeded. */
  const setAsideNow = async (ids: string[], retrying = false) => {
    if (!read.setAside || !ids.length) return;
    setBusy(true);
    remember(allRows().filter(row => ids.includes(row.key)));
    if (!retrying) {
      setLastLanes(old => [...ids, ...old.filter(id => outcome[id] === 'failed' && !ids.includes(id))]);
      setSeeAll(old => ({ ...old, lanes: false }));
    }
    const { results, versions } = await setAsideLanes(sweep, read.setAside.authorityEpoch, ids);
    setOutcome(old => ({ ...old, ...results }));
    setBusy(false);
    const done = ids.filter(id => results[id] === 'abandoned');
    const back = done.flatMap(id =>
      versions[id] === undefined ? [] : [{ laneId: id, version: versions[id]! }],
    );
    setUndoLanes(old => (retrying ? [...old, ...back] : back));
    setLastDone(old => ({ ...old, lanes: (retrying ? (old.lanes ?? 0) : 0) + done.length }));
    const words = `Set aside ${count(done.length, 'Lane')}. Every save is kept.`;
    if (done.length === ids.length && !retrying)
      setToast({ text: words, undo: back.length ? () => void bringBack(back) : null });
    announce(
      `${done.length.toLocaleString('en')} set aside${ids.length - done.length ? `, ${(ids.length - done.length).toLocaleString('en')} left alone, each named in the list` : ''}. Every save is kept.`,
    );
  };
  const bringBack = async (pins: { laneId: string; version: number }[]) => {
    if (!read.setAside || !pins.length) return;
    setBusy(true);
    setToast(null);
    const results = await bringBackLanes(sweep, read.setAside.authorityEpoch, pins);
    // Only what came back changes its row. A Lane that changed since stays set aside; one whose call failed keeps its
    // Undo pin, so Undo (never the set-aside Retry) tries it again.
    const back = pins.filter(pin => results[pin.laneId] === 'reopened').map(pin => pin.laneId);
    setOutcome(old => ({ ...old, ...Object.fromEntries(back.map(id => [id, 'reopened'])) }));
    const failedBack = pins.filter(pin => results[pin.laneId] === 'failed');
    setUndoLanes(old => old.filter(pin => failedBack.some(f => f.laneId === pin.laneId)));
    setLastDone(old => ({ ...old, lanes: failedBack.length ? old.lanes : null }));
    setBusy(false);
    const changed = pins.length - back.length - failedBack.length;
    announce(
      `Brought back ${count(back.length, 'Lane')}.` +
        (back.length === pins.length ? ' The Lanes are open again.' : '') +
        (changed ? ` ${changed.toLocaleString('en')} changed meanwhile and stay set aside.` : '') +
        (failedBack.length
          ? ` ${failedBack.length.toLocaleString('en')} could not be reached; Undo tries again.`
          : ''),
    );
  };
  /** A new trash request per row, pinned to what the read showed. */
  const trashPins = (rows: ScreenRow[]): LifecycleArgs[] =>
    rows.flatMap(row =>
      row.trash && !here(row)
        ? [
            {
              projectId: row.key,
              operationId: crypto.randomUUID(),
              expectedRevision: row.trash.expectedRevision,
              ...(row.trash.expectedLastLanding === undefined
                ? {}
                : { expectedLastLanding: row.trash.expectedLastLanding }),
            },
          ]
        : [],
    );
  /** Move projects to the trash. A retry replays the exact failed requests and keeps the earlier rows' Undo pins. */
  const trashNow = async (pins: LifecycleArgs[], rows: ScreenRow[], retrying = false) => {
    if (!pins.length) return;
    setBusy(true);
    remember(rows);
    const ids = pins.map(pin => pin.projectId);
    if (!retrying) {
      setLastProjects(old => [...ids, ...old.filter(id => trashed[id] === 'failed' && !ids.includes(id))]);
      setSeeAll(old => ({ ...old, projects: false }));
    }
    const results = await trashProjects(trash, pins);
    const failedNow = pins.filter(pin => results[pin.projectId] === 'failed');
    setProjectRetry(old =>
      retrying ? failedNow : [...old.filter(pin => !ids.includes(pin.projectId)), ...failedNow],
    );
    setTrashed(old => ({ ...old, ...results }));
    setBusy(false);
    const done = pins.filter(pin => results[pin.projectId] === 'trashed');
    // The trash wrote the next revision: Undo restores at exactly that one.
    const back = done.map(pin => ({
      projectId: pin.projectId,
      operationId: crypto.randomUUID(),
      expectedRevision: pin.expectedRevision + 1,
    }));
    setUndoProjects(old => (retrying ? [...old, ...back] : back));
    setLastDone(old => ({ ...old, projects: (retrying ? (old.projects ?? 0) : 0) + done.length }));
    const named = (id: string) =>
      (titles[id] ?? rows.find(row => row.key === id)?.title ?? 'The project').slice(0, 40);
    const words =
      done.length === 1
        ? `${named(done[0]!.projectId)} moved to the trash. It can be restored for 90 days.`
        : `${count(done.length, 'project')} moved to the trash. They can be restored for 90 days.`;
    if (done.length === pins.length && !retrying)
      setToast({ text: words, undo: () => void restoreNow(back) });
    announce(
      done.length === pins.length
        ? words
        : `${done.length.toLocaleString('en')} moved to the trash, ${(pins.length - done.length).toLocaleString('en')} left alone, each named in the list.`,
    );
  };
  const restoreNow = async (pins: LifecycleArgs[]) => {
    if (!pins.length) return;
    setBusy(true);
    setToast(null);
    const results = await restoreProjects(restore, pins);
    // As for Lanes: only a restored project changes its row; a failed restore keeps its Undo pin for Undo to retry.
    const back = pins.filter(pin => results[pin.projectId] === 'restored').map(pin => pin.projectId);
    setTrashed(old => ({ ...old, ...Object.fromEntries(back.map(id => [id, 'restored' as const])) }));
    const failedBack = pins.filter(pin => results[pin.projectId] === 'failed');
    setUndoProjects(old => old.filter(pin => failedBack.some(f => f.projectId === pin.projectId)));
    setLastDone(old => ({ ...old, projects: failedBack.length ? old.projects : null }));
    setBusy(false);
    const changed = pins.length - back.length - failedBack.length;
    announce(
      `Restored ${count(back.length, 'project')} from the trash.` +
        (changed ? ` ${changed.toLocaleString('en')} changed meanwhile and stay in the trash.` : '') +
        (failedBack.length
          ? ` ${failedBack.length.toLocaleString('en')} could not be reached; Undo tries again.`
          : ''),
    );
  };
  const handNow = (rows: ScreenRow[]) => {
    const lanes = rows.flatMap(row => (row.laneId ? [{ laneId: row.laneId, title: row.title }] : []));
    if (!lanes.length) return;
    const text = handText(lanes, project);
    const words = `Copied ${lanes.length === 1 ? 'a prompt that hands this Lane' : `one prompt that hands ${count(lanes.length, 'Lane')}`} to an agent. Paste it into the agent app you use.`;
    copy(text).then(
      () => {
        setToast({ text: words, undo: null });
        announce(words);
      },
      () => announce(`Could not copy. The prompt is: ${text}`),
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
  // Every row left alone stays named here, even when the live read no longer lists it; a failed one keeps its retry.
  const leftOf = (
    results: Record<string, string>,
    last: readonly string[],
    done: string,
    all: boolean,
    word: (result: string) => { word: string },
  ) => {
    const ids = last.filter(
      id => results[id] && results[id] !== done && !['reopened', 'restored'].includes(results[id]!),
    );
    return {
      ids,
      failed: ids.filter(id => results[id] === 'failed'),
      skipped: ids.filter(id => results[id] !== 'failed'),
      named: (all ? ids : ids.slice(0, 5)).map(id => {
        const said = word(results[id]!).word;
        return `“${titles[id] ?? `Lane ${id.slice(0, 8)}`}” ${results[id] === 'failed' ? 'could not be reached' : said.replace(/^Skipped: /, 'skipped: ')}`;
      }),
    };
  };
  const lanesLeft = leftOf(outcome, lastLanes, 'abandoned', seeAll.lanes, setAsideWord);
  const projectsLeft = leftOf(trashed, lastProjects, 'trashed', seeAll.projects, result =>
    trashWord(result as TrashResult),
  );
  const left = (kind: typeof lanesLeft, head: string, lead: string): LeftAlone | null =>
    kind.ids.length
      ? {
          head: `${kind.ids.length.toLocaleString('en')} ${head}`,
          lead,
          named: kind.named,
          more: kind.ids.length - kind.named.length,
          failed: kind.failed.length,
          skipped: kind.skipped.length,
        }
      : null;
  const laneNotice = left(
    lanesLeft,
    'could not be set aside',
    lastDone.lanes === null
      ? ''
      : `${lastDone.lanes.toLocaleString('en')} ${lastDone.lanes === 1 ? 'Lane was' : 'Lanes were'} set aside in your last try. `,
  );
  const projectNotice = left(
    projectsLeft,
    'could not be moved to the trash',
    lastDone.projects === null
      ? ''
      : `${count(lastDone.projects, 'project')} moved to the trash in your last try. `,
  );
  const actionKey = (row: ScreenRow, section: Section) => {
    const lane = outcome[row.key];
    const project = trashed[row.key];
    if (lane) {
      const word = row.intent ? intentWord(lane) : setAsideWord(lane);
      return (
        <State word={word.done ? 'Set aside' : word.retry ? 'Check failed' : 'Not seen'}>{word.word}</State>
      );
    }
    if (project) {
      const word = trashWord(project as TrashResult);
      return (
        <State word={word.done ? 'Set aside' : word.retry ? 'Check failed' : 'Not seen'}>{word.word}</State>
      );
    }
    if (row.action === 'open' && row.itemId)
      return (
        <A className="btn sm ghost" href={itemHref(row.itemId)}>
          Open the Item
        </A>
      );
    if (row.action === 'set-aside')
      return (
        <Key size="sm" disabled={busy} onClick={() => void setAsideNow([row.key])}>
          Set aside
        </Key>
      );
    if (row.action === 'tidy')
      return (
        <Key size="sm" disabled={busy} onClick={() => void intents.run([row])}>
          Set aside
        </Key>
      );
    if (row.action === 'hand')
      return (
        <Key size="sm" onClick={() => handNow([row])}>
          Hand to an agent
        </Key>
      );
    if (row.action === 'trash' && here(row))
      return (
        <Key
          size="sm"
          disabled
          title="This page belongs to this project. Open another project to move it to the trash."
        >
          Move to the trash
        </Key>
      );
    if (row.action === 'trash')
      return (
        <Key size="sm" disabled={busy} onClick={() => void trashNow(trashPins([row]), [row])}>
          Move to the trash
        </Key>
      );
    // Another person's leftover project: only its owner moves it to the trash.
    if (section.key === 'projects')
      return (
        <Key size="sm" disabled title="Only the project’s owner can move it to the trash.">
          Move to the trash
        </Key>
      );
    return null;
  };
  return (
    <div className="needs-me loose-ends">
      {head(
        <>
          <b>{screen.sentence.bold}</b> {screen.sentence.rest}
        </>,
      )}
      {cliOut}
      {notice}
      {laneNotice ? (
        <ResultNotice
          left={laneNotice}
          busy={busy}
          onRetry={() => void setAsideNow(lanesLeft.failed, true)}
          onSeeLeft={seeAll.lanes ? null : () => setSeeAll(old => ({ ...old, lanes: true }))}
          onUndo={undoLanes.length ? () => void bringBack(undoLanes) : null}
        />
      ) : null}
      {projectNotice ? (
        <ResultNotice
          left={projectNotice}
          busy={busy}
          onRetry={() => void trashNow(projectRetry, [], true)}
          onSeeLeft={seeAll.projects ? null : () => setSeeAll(old => ({ ...old, projects: true }))}
          onUndo={undoProjects.length ? () => void restoreNow(undoProjects) : null}
        />
      ) : null}
      {intents.left ? (
        <ResultNotice
          left={intents.left}
          busy={busy}
          onRetry={intents.retry}
          onSeeLeft={intents.seeLeft}
          onUndo={intents.undo}
        />
      ) : null}
      <section className="region" aria-label="Loose ends">
        {pickable.length ? (
          <div className="bulk" role="region" aria-label="Selected">
            <b className="num">{pickable.length.toLocaleString('en')} selected</b>
            {idleEligible.length && (idleOn < idleEligible.length || idle?.cursor) ? (
              <Key size="sm" kind="ghost" disabled={busy || selecting} onClick={() => void selectAll()}>
                {selecting
                  ? 'Selecting…'
                  : `Select all ${idleEligible.length.toLocaleString('en')}${idle?.cursor ? ' or more' : ''} Lanes nobody holds`}
              </Key>
            ) : null}
            <span className="grow" />
            {pickedIdle.length ? (
              <Key
                size="sm"
                kind="rec"
                disabled={busy}
                onClick={() => void setAsideNow(pickedIdle.map(row => row.key))}
              >
                Set aside {pickedIdle.length.toLocaleString('en')}
                {pickedIntents.length ? ' Lanes' : ''}
              </Key>
            ) : null}
            {pickedIntents.length ? (
              <Key size="sm" kind="rec" disabled={busy} onClick={() => void intents.run(pickedIntents)}>
                Set aside {pickedIntents.length.toLocaleString('en')}{' '}
                {pickedIntents.length === 1 ? 'Intent' : 'Intents'}
              </Key>
            ) : null}
            {pickedLanes.length ? (
              <Key size="sm" onClick={() => handNow(pickedLanes)}>
                Hand to an agent
              </Key>
            ) : null}
            {pickedProjects.length ? (
              <Key
                size="sm"
                disabled={busy}
                onClick={() => void trashNow(trashPins(pickedProjects), pickedProjects)}
              >
                Move {pickedProjects.length.toLocaleString('en')} to the trash
              </Key>
            ) : null}
            <Key
              size="sm"
              kind="ghost"
              keys="Esc"
              aria-label="Clear the selection"
              onClick={() => {
                clears.current++;
                setPicked(new Set());
              }}
            >
              Clear
            </Key>
          </div>
        ) : null}
        {screen.total === 0 && screen.exhausted ? (
          <div className="quietline">
            {screen.intentsUnread
              ? 'No loose ends in Lanes or projects. Open Intents are read on request below.'
              : 'No loose ends. Forge looks again whenever a Lane or a project changes, not on a timer.'}
          </div>
        ) : null}
        {screen.sections.map(section => {
          if (
            section.reported &&
            !section.rows.length &&
            !section.cursor &&
            !section.why &&
            !section.unread &&
            !section.deleteRequests.length
          )
            return null;
          const shown = section.rows.filter(eligible).map(row => row.key);
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
                {section.reported && !section.unread ? (
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
              {section.unread ? (
                <div className="le-more">
                  <span>
                    {state === 'failed'
                      ? 'Could not load them. Nothing changed.'
                      : 'Read on request, 25 at a time'}
                  </span>
                  <Key
                    size="sm"
                    disabled={state === 'loading'}
                    onClick={() => void more('intents', INTENT_CURSOR)}
                  >
                    {state === 'failed' ? 'Try again' : state === 'loading' ? 'Loading…' : 'Look for them'}
                  </Key>
                </div>
              ) : null}
              {section.rows.map(row => {
                const canPick = eligible(row);
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
                      {row.who || row.proposed ? (
                        <div className="meta">
                          {row.who ? <WholeWho handle={row.who} /> : null}
                          {row.proposed ? <span className="prop">proposed</span> : null}
                        </div>
                      ) : null}
                    </div>
                    <span className="meta any" dir="auto">
                      {row.evidence}
                    </span>
                    <span className="meta r num">{row.age}</span>
                    <span className="r">{actionKey(row, section)}</span>
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
              {/* One row per open permanent-delete request, each opening that request on the account page. */}
              {section.deleteRequests.map(request => (
                <A key={request.id} className="row le-waiting" href={`/account?request=${request.id}`}>
                  <div>
                    <div className="ttl">
                      {count(request.projects, 'project')}{' '}
                      {request.selector === 'the trash' ? 'in the trash ' : ''}
                      {request.projects === 1 ? 'waits' : 'wait'} for you
                    </div>
                    <div className="meta">
                      {request.byDevice
                        ? 'an agent or device asked to delete them for good'
                        : 'you asked to delete them for good'}
                    </div>
                  </div>
                  <span className="t3" aria-hidden="true">
                    ›
                  </span>
                </A>
              ))}
            </div>
          );
        })}
        <div className="pf">
          A loose end leaves this list when someone saves to it, lands it, sets it aside or moves it to the
          trash.
        </div>
      </section>
      {toast ? <ResultToast toast={toast} onDone={endToast} /> : null}
      <Announcer message={message} />
    </div>
  );
}

/** Who, as the approved page shows it: the mark and the whole public address (`@handle` or `handle/agent`). */
function WholeWho({ handle }: { handle: string }) {
  return (
    <span className="who" title={handle}>
      <Avatar handle={handle} />
      <span className="a-run mono" dir="auto" translate="no">
        {handle}
      </span>
    </span>
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
