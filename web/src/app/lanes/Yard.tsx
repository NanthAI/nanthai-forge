// SPDX-License-Identifier: Apache-2.0
// The yard (DESIGN.md figures): every open Lane on the shell's four stops (Editing, Saved, In queue, Checking) and main, in bands, stuck work first. The
// Checking and passed-waiting use the shell strip's counts. Each
// row opens its Lane; a Lane whose check failed opens that check instead (the approved flow's lanes.html), whose trail
// leads on to the Lane. The band that waits on the reader is the first stop. Static markup: no behaviour layer.
// A running check (Item ecd6e610) says how long it has run against the project's usual check, and its mark glides
// along the Checking stop by a CSS animation drawn from the check's start: the browser moves it with no script per
// frame and no server call. One timer at most, for the whole yard, armed only for the next minute its words change and
// never past the usual slowest check, none while live reads sleep (hidden or idle tab), when the mark rests in place.
// A Lane that saved a file another open Lane also saved says so under its row, "shares 3 files with 2 Lanes", linked to
// Who is touching what for that Lane (Item f787005c); a link of its own, beside the row's link, never inside it.
// Above the bands, the four stops and main with the Lanes at each (the approved flow lanes.html): the top bar's own
// counts when every Lane is shown (count, and passed at Checking, as the top bar says them), the shown rows' otherwise.
// Each row starts with who holds it (the Lane's mark at left), then its title, then who (Item 41514fee: run · model ·
// for @person), then the agent app and when it was last seen. A row the reader can move on has its one action at the
// right: Review a Lane that needs you, View conflict on a held conflict, Open check on a failed check (whether Retry is
// offered is the check screen's to say: its read's `recovery`, Item b030c3c5). Each is a link to the screen that owns
// it; the yard writes nothing. Return opens the first Review or View conflict, only with focus on the yard or the page
// itself, never while typing or on a control.
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Avatar, Group, State } from '../../ds';
import { useReadsAsleep } from '../../live-reads';
import { A } from '../frames';
import { navigate } from '../router';
import { agentAppLabels, type AgentApp } from '../start/agent-apps';
import { RecordedWho } from '../RecordedWho';
import { declaredModel, recordedIdentity, type WhoProject } from '../who-links';
import { lineStops, passedWaiting, type lineStopCounts, type LineStage } from '../Line';
import {
  ago,
  CHECK_FROM,
  CHECK_TO,
  bandTitles,
  checkProgress,
  heldUnsure,
  sharesWords,
  stopWords,
  type Band as BandName,
  type LaneShares,
  type Yard as YardModel,
  type YardRow,
} from './model';

/** Where on the track a Lane sits: the middle of its stop on the line's four stops (0 to 4, main at 4). A passed
 * check ('ready') counts at Checking (Line.tsx `lineStops`) and rests near its end, past a running check. */
const place: Record<LineStage, number> = {
  editing: 0.5,
  saved: 1.5,
  queued: 2.5,
  checking: 3.4,
  ready: 3.85,
};
const order: readonly BandName[] = ['needs', 'held', 'queue', 'work', 'quiet'];

/** The agent app a run declared (`claude-code:model`), by its name; "app not reported" for an agent run that sent
 * none; nothing for a person. */
function harnessOf(row: Pick<YardRow, 'agent' | 'agentRun' | 'agentClient'>) {
  const app = row.agentClient?.split(':')[0];
  if (app) return agentAppLabels[app as AgentApp] ?? app;
  return row.agent || row.agentRun ? 'app not reported' : undefined;
}

/** The one thing a reader can do next on a row, as a link to the screen that owns it; null for none. */
type RowAction = { label: string; href: string; enter: boolean; rec: boolean };
function rowAction(row: YardRow, href: string, checkHref: string | undefined): RowAction | null {
  // The yard cannot know whether this check can be retried (the check read's `recovery`), so it opens the check.
  if (row.state === 'failed' && checkHref)
    return { label: 'Open check', href: checkHref, enter: false, rec: row.band === 'needs' };
  if (row.band === 'needs') return { label: 'Review', href, enter: true, rec: true };
  if (row.band === 'held' && row.state === 'conflict')
    return { label: 'View conflict', href, enter: true, rec: false };
  return null;
}

/** Whether Return is the yard's: focus on the yard or on the page itself (body, main), no modifier, not typing, not in
 * a dialog and not on a control of its own. */
function yardEnter(event: KeyboardEvent, yard: HTMLElement | null) {
  if (event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  if (event.defaultPrevented || !yard) return false;
  const target = event.target as HTMLElement | null;
  const page = target === document.body || target === document.documentElement || target?.tagName === 'MAIN';
  if (!page && !(target && yard.contains(target))) return false;
  return !target?.closest?.(
    'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="dialog"], a, button, summary, [role="button"], [tabindex]:not([tabindex="-1"])',
  );
}

/** A stop as the top bar says it: the count, "+" when the feed lists fewer Lanes than are open, passed at Checking. */
function stopCount(stop: YardModel['stops'][number]) {
  const n = `${stop.count.toLocaleString()}${stop.atLeast ? '+' : ''}`;
  return stop.passed ? `${n} · ${stop.passed.toLocaleString()} passed` : n;
}
/** The shown rows at each stop, by the top bar's rule: a held Lane at Checking is not counted, a passed one is apart. */
function rowStops(rows: readonly YardRow[]): YardModel['stops'] {
  return lineStops.map(stop => {
    let count = 0;
    let passed = 0;
    for (const row of rows) {
      if (!stop.of.includes(row.stage)) continue;
      if (row.stage === 'ready') passed++;
      else if (row.stage !== 'checking' || (row.band !== 'needs' && row.band !== 'held')) count++;
    }
    return { count, passed, atLeast: false };
  });
}

export function Yard({
  rows,
  project,
  checking,
  hrefOf,
  checkHrefOf,
  dense,
  sharesOf,
  sharesHref,
  stops,
  needsKnown = 'all',
}: {
  rows: readonly YardRow[];
  project?: WhoProject | undefined;
  checking?: ReturnType<typeof lineStopCounts> | undefined;
  hrefOf: (laneId: string) => string;
  /** Where a Lane's check evidence is; a failed row links there. Without it every row opens its Lane. */
  checkHrefOf?: (laneId: string) => string;
  dense: boolean;
  /** What a Lane shares with other open Lanes, from the one overlap read; absent when it shares nothing. */
  sharesOf?: (laneId: string) => LaneShares | undefined;
  sharesHref?: (laneId: string) => string;
  /** The four stops when the yard shows every Lane (the top bar's counts); else counted from the shown rows. */
  stops?: YardModel['stops'] | undefined;
  /** Whether every held Lane was checked against the reader; else Held says some may still wait on them. */
  needsKnown?: YardModel['needsKnown'];
}) {
  const { now, asleep } = useCheckClock(rows);
  const checkOf = (row: YardRow) => (row.state === 'failed' ? checkHrefOf?.(row.laneId) : undefined);
  const actions = rows.map(row => rowAction(row, hrefOf(row.laneId), checkOf(row)));
  // Return opens the first Review or View conflict; only that row shows the key.
  const firstEnter = actions.findIndex(action => action?.enter);
  const enter = firstEnter >= 0 ? actions[firstEnter]!.href : undefined;
  const yard = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!enter) return;
    const onKey = (event: KeyboardEvent) => {
      if (!yardEnter(event, yard.current)) return;
      // The first Review or View conflict the reader can see: a row in a folded group is not one.
      const shown = [...(yard.current?.querySelectorAll<HTMLAnchorElement>('a[data-enter]') ?? [])].find(
        link => link.offsetParent !== null,
      );
      if (!shown) return;
      event.preventDefault();
      navigate(shown.getAttribute('href') ?? enter);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [enter]);
  const counts = stops ?? rowStops(rows);
  return (
    <div ref={yard} className={dense ? 'yard dense' : 'yard'}>
      <div className="zones" aria-hidden="true">
        <div className="zl" />
        <div className="zs">
          {lineStops.map((stop, i) => (
            <span key={stop.stage}>
              {stop.label} <b>{counts[i] ? stopCount(counts[i]) : '0'}</b>
            </span>
          ))}
          <span className="zm" title="main">
            main
          </span>
        </div>
        <div className="zl" />
      </div>
      {order.map(band => {
        const inBand = rows.filter(row => row.band === band);
        if (!inBand.length) return null;
        return (
          <Group
            key={band}
            id={`lanes.open.${band}`}
            role="list"
            title={bandTitles[band].title}
            count={inBand.length}
            hint={
              band === 'queue' && checking?.passed
                ? `Checking ${checking.count.toLocaleString('en')} · ${passedWaiting(checking.passed)}`
                : band === 'held' && needsKnown !== 'all'
                  ? heldUnsure
                  : bandTitles[band].hint
            }
            needs={band === 'needs'}
          >
            {inBand.map(row => {
              const shares = sharesHref ? sharesOf?.(row.laneId) : undefined;
              return (
                <div role="listitem" key={row.laneId} className={shares ? 'ln-item sh' : 'ln-item'}>
                  <LaneLine
                    row={row}
                    project={project}
                    href={hrefOf(row.laneId)}
                    checkHref={checkOf(row)}
                    action={actions[rows.indexOf(row)] ?? null}
                    keyHint={rows.indexOf(row) === firstEnter}
                    dense={dense}
                    now={now}
                    glide={!asleep}
                  />
                  {shares && sharesHref ? (
                    <div className="ln-sh">
                      <A className="lk" href={sharesHref(row.laneId)}>
                        <span className="sr" dir="auto">
                          {row.title}:{' '}
                        </span>
                        {sharesWords(shares)}
                      </A>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </Group>
        );
      })}
    </div>
  );
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** The render time for the yard's running checks, redrawn once at the next moment any of their words change by
 * themselves; asleep, nothing is armed and the marks rest. Server writes redraw it as they always do. */
function useCheckClock(rows: readonly YardRow[]) {
  const [tick, redraw] = useState(0);
  const asleep = useReadsAsleep();
  const now = Date.now();
  const next = Math.min(
    ...rows.map(row => (row.check ? checkProgress(row.check, now, clock).nextAt : Infinity)),
  );
  useEffect(() => {
    if (asleep || next === Infinity || document.hidden) return;
    const timer = setTimeout(() => redraw(n => n + 1), Math.max(0, next - Date.now()));
    return () => clearTimeout(timer);
  }, [asleep, next, tick]); // tick: a timer that fired a moment early arms again for the same moment.
  return { now, asleep };
}

function LaneLine({
  row,
  project,
  href,
  checkHref,
  dense,
  now,
  glide,
  action,
  keyHint,
}: {
  row: YardRow;
  project?: WhoProject | undefined;
  href: string;
  checkHref?: string | undefined;
  action: RowAction | null;
  keyHint: boolean;
  dense: boolean;
  now: number;
  glide: boolean;
}) {
  const who = recordedIdentity(row.actor, row.agentRun);
  const progress = row.check ? checkProgress(row.check, now, clock) : null;
  // Past the usual slowest check: the warning tone. The server's deadline still ends a dead check.
  const state = progress?.overdue ? 'waiting' : row.state;
  const why = progress ? progress.why : row.why;
  const detail = progress ? progress.detail : row.detail;
  // From where it is now to the end of the stop, over what is left of the usual check; overdue it holds at the end.
  const going = !!progress && glide && progress.fraction < 1 && row.check!.usualMs !== null;
  const track = {
    '--p': progress ? progress.at : place[row.stage],
    ...(going
      ? {
          '--p0': CHECK_FROM,
          '--p1': CHECK_TO,
          '--run': `${row.check!.usualMs}ms`,
          '--from': `${-(now - row.check!.startedAt)}ms`,
        }
      : {}),
  } as CSSProperties;
  const where = `${stopWords[row.stage]}${row.position ? `, number ${row.position} in the queue` : ''}`;
  // Two open Lanes of one Item must never look the same: the short Lane mark, and how many the Item has.
  const mark = row.untitled ? null : row.mark;
  const name = [row.title, mark ? `Lane ${mark}` : null, checkHref ? 'open its check' : null]
    .filter(Boolean)
    .join(', ');
  return (
    <div className="ln" data-st={state}>
      <div className="lab">
        <Avatar handle={who ?? '?'} />
        <A
          className={dense ? 'ttl ln-open' : 'ttl ln-open wrap2'}
          href={checkHref ?? href}
          dir="auto"
          aria-label={name === row.title ? undefined : name}
        >
          {row.title}
        </A>
        <RecordedWho
          handle={who}
          agentAuthored={row.agent}
          model={declaredModel(row.agentClient)}
          project={project}
          layout="line"
        />
        {/* Two open Lanes of one Item never look the same: the short Lane mark and the count stay whole even in a
            dense row (Items d9e1ac62, 1dd4e095), so they come first; a Lane alone needs neither. */}
        <div className="meta cut">
          {mark && row.lanes > 1 ? (
            <>
              <span className="mono mk" translate="no" title={`Lane ${row.laneId}`}>
                {mark}
              </span>
              {` · ${row.lanes.toLocaleString()} Lanes · `}
            </>
          ) : null}
          {[harnessOf(row), row.seenAt === null ? 'last seen not reported' : `seen ${ago(now - row.seenAt)}`]
            .filter(Boolean)
            .join(', ')}
        </div>
      </div>
      <div className={going ? 'trk going' : 'trk'} style={track} aria-hidden="true">
        <div className="rl">
          <i className="fl" />
          <div className="nw">
            <i className={row.position ? 'nd num' : 'nd'}>
              {row.position ? (row.position > 999 ? '999+' : row.position) : null}
            </i>
          </div>
        </div>
      </div>
      <div className="actn">
        <State word={row.glyph} state={state}>
          {row.word}
        </State>
        <span className="why">
          <b>{why}</b>
          {detail ? <> {detail}</> : null}
        </span>
        <span className="sr">. {where}</span>
        {action ? (
          <A
            className={action.rec ? 'btn sm rec' : 'btn sm'}
            href={action.href}
            data-enter={action.enter || undefined}
          >
            <span>{action.label}</span>
            {keyHint ? <kbd aria-hidden="true">↵</kbd> : null}
            <span className="sr">: {row.title}</span>
          </A>
        ) : null}
      </div>
    </div>
  );
}
