import { useGenerationFreshness } from '../ui/generation-freshness';
// SPDX-License-Identifier: Apache-2.0
import { Glyph, type GlyphName } from '../ui/Glyph';
import { Avatar, DiffStat, Dot, StatusPill } from '../ui/primitives';
import { Rail } from '../ui/Rail';
import type { LaneFact } from '../ui/lane-facts';
import { age, seenAt, type Tone } from '../ui/status';
import type { CockpitLane } from './model';

const factGlyph: Partial<Record<Tone, GlyphName>> = {
  conflict: 'conflict',
  failed: 'failed',
  passed: 'passed',
  running: 'running',
  waiting: 'sync',
};

/** Who is on the Lane and what they are doing: the live session first, then who started it. */
function Who({ lane, now }: { lane: CockpitLane; now: number }) {
  const session = lane.session;
  const agent = session ? !session.person : lane.startedBy ? lane.startedBy.kind === 'agent' : lane.byAgent;
  const recordedName = session?.name ?? lane.startedBy?.name ?? (lane.owner || undefined);
  const name =
    !recordedName ||
    /^agent workflow$/i.test(recordedName.trim()) ||
    /^(contributor_|user_|[0-9a-f]{8}-)/i.test(recordedName)
      ? undefined
      : recordedName;
  if (!name) return <div className="fx-row-who" />;
  const state = session
    ? session.tone === 'stale'
      ? `not seen since ${seenAt(session.lastSeen, now)}`
      : lane.tone === 'passed' && session.tone === 'waiting'
        ? 'waiting for you'
        : `${session.tone === 'plain' ? 'quiet' : session.tone === 'waiting' ? 'waiting' : 'working'} · ${age(session.lastSeen, now)}`
    : lane.startedBy?.tool;
  return (
    <div className="fx-row-who">
      <Avatar name={name} kind={agent ? 'agent' : 'human'} />
      <div>
        <div className="fx-row-name">
          <span title={name}>{agent ? name : name.split(/\s+/)[0]}</span>
        </div>
        {state && (
          <div className="fx-row-seen">
            {session && <Dot tone={session.tone} />}
            {state}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One Lane: status and name, its Intent when it differs, the fact line from `lane-facts` (concept
 * model §3); who; journey rail; diff; age.
 */
export function LaneRow({
  lane,
  fact,
  now,
  href,
  viewHref,
}: {
  lane: CockpitLane;
  /** The shared fact line; without it the row uses the cockpit's own words. */
  fact?: LaneFact;
  now: number;
  href: string;
  viewHref?: (id: string) => string;
}) {
  const freshness = useGenerationFreshness();
  const tone = fact?.tone ?? lane.tone;
  const text = fact?.text ?? lane.fact;
  const intent = fact ? fact.intent : lane.intent !== lane.name ? lane.intent : undefined;
  return (
    <li className={`fx-row fx-row-${tone}`}>
      <div className="fx-row-main">
        <div className="fx-row-title">
          <StatusPill tone={tone} {...(fact?.pillGlyph ? { glyph: fact.pillGlyph } : {})}>
            {fact?.label ?? lane.label}
          </StatusPill>
          <a className="fx-row-lane" href={href} title={lane.name}>
            {lane.name}
          </a>
          {intent && (
            <span className="fx-row-intent" title={`Intent: ${intent}`}>
              <Glyph name="intent" size={11} />
              <em>{intent}</em>
            </span>
          )}
        </div>
        {text && (
          <div className={`fx-row-fact fx-fact-${tone}`}>
            <Glyph
              name={
                freshness.behind && tone === 'running'
                  ? 'stale'
                  : (fact?.glyph ?? factGlyph[tone] ?? (lane.checkpoints ? 'file' : 'waiting'))
              }
              size={12}
            />
            <span title={fact?.detail ?? (freshness.behind ? `${text} · ${freshness.asOf}` : text)}>
              {text}
              {lane.laterViewId && viewHref && (
                <>
                  {' '}
                  · <a href={viewHref(lane.laterViewId)}>Later Candidate</a>
                </>
              )}
            </span>
          </div>
        )}
      </div>
      <Who lane={lane} now={now} />
      <Rail lane={lane} dim={tone === 'stale' || lane.session?.tone === 'stale'} />
      <div className="fx-row-stat">
        {lane.changes?.add !== undefined ? (
          <>
            <DiffStat add={lane.changes.add} del={lane.changes.del ?? 0} />
            <small>
              {lane.changes.files} {lane.changes.files === 1 ? 'file' : 'files'}
            </small>
          </>
        ) : lane.changes ? (
          <small title="Paths in the latest reported change">
            {lane.changes.files} {lane.changes.files === 1 ? 'file' : 'files'}
          </small>
        ) : lane.checkpoints === 0 ? (
          <small>no saves</small>
        ) : null}
      </div>
      <div className="fx-row-age">{lane.lastAt ? age(lane.lastAt, now) : ''}</div>
    </li>
  );
}
