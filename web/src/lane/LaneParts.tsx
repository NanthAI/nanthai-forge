// SPDX-License-Identifier: Apache-2.0
import { displayLaneName } from '../../../src/lane-name';
import type { ReactNode } from 'react';
import type { CockpitLane } from '../cockpit/model';
import { Glyph, type GlyphName } from '../ui/Glyph';
import { Avatar, DiffStat, Dot, StatusPill } from '../ui/primitives';
import { Rail } from '../ui/Rail';
import { age, type Tone } from '../ui/status';

export type Step = { tone: Tone; glyph: GlyphName; title: string; body: string; nobody?: true; queue?: true };

/**
 * One sentence about what happens next and whether the viewer is needed.
 * `since` (e.g. `last save 3 h ago`) marks the page as able to tell that nobody holds an open Lane.
 */
export function nextStep(lane: CockpitLane, since?: string): Step {
  if (lane.queue?.step && lane.tone !== 'conflict')
    return lane.queue.state === 'review' && !lane.queue.step.body
      ? {
          ...lane.queue.step,
          body:
            lane.session?.name ??
            (lane.startedBy?.name !== 'Agent workflow' ? (lane.startedBy?.name ?? '') : ''),
        }
      : lane.queue.step;
  if (lane.queue && ['later', 'not-run', 'working'].includes(lane.queue.state))
    return { tone: 'plain', glyph: 'plain', title: '', body: '' };
  if (!lane.open)
    return {
      tone: 'plain',
      glyph: 'passed',
      // Closed/selected source is not itself a canonical owner receipt.
      title: 'Done',
      body: '',
    };
  switch (lane.tone) {
    case 'conflict':
      return {
        tone: 'conflict',
        glyph: 'conflict',
        title: `Can't update from main: ${lane.conflicts.length || 'some'} conflicting ${lane.conflicts.length === 1 ? 'file' : 'files'}`,
        body: 'Resolve the conflict markers in the Lane folder, save, then finish again.',
      };
    case 'failed':
      return {
        tone: 'failed',
        glyph: 'failed',
        title: 'Not ready to accept: the check failed',
        body: 'Fix the failures in the Lane and finish again. If the failure was unrelated, run the check again on the same Candidate.',
      };
    case 'running':
      return {
        tone: 'running',
        glyph: 'running',
        title: 'Checking…',
        body: 'The check is running on the latest Candidate of this Lane.',
      };
    case 'passed':
      return {
        tone: 'passed',
        glyph: 'review',
        title: 'Stopped for your review. The check passed on exactly this code.',
        body:
          lane.session?.name ??
          (lane.startedBy?.name !== 'Agent workflow' ? (lane.startedBy?.name ?? '') : ''),
      };
    case 'waiting':
      if (lane.label === 'Needs update')
        return {
          tone: 'waiting',
          glyph: 'sync',
          title: 'Needs an update from main',
          body: 'The check passed, but main has moved since. Finishing again updates the Lane from main and re-checks it.',
        };
    default:
      if (since !== undefined && lane.tone === 'active' && !lane.session)
        return {
          tone: 'waiting',
          glyph: 'person',
          title: ['Nobody is working on this Lane', since].filter(Boolean).join(' · '),
          body: '',
          nobody: true,
        };
      return lane.checkpoints
        ? {
            tone: 'active',
            glyph: 'lane',
            title: 'Work in progress',
            body: `${lane.checkpoints} ${lane.checkpoints === 1 ? 'save' : 'saves'} so far. `,
          }
        : {
            tone: 'active',
            glyph: 'lane',
            title: 'No saved changes yet',
            body: 'Edit files in the Lane folder; save with a checkpoint, or finish to check and review.',
          };
  }
}

export function NextStep({ step, actions }: { step: Step; actions?: ReactNode }) {
  if (step.tone === 'active' || step.tone === 'plain' || (step.tone === 'failed' && !step.queue)) return null;
  return (
    <section className={`fx-next fx-tone-${step.tone}`} aria-label="What happens next" role="status">
      <span className="fx-next-icon">
        <Glyph name={step.glyph} size={16} />
      </span>
      <div>
        <h2>{step.title}</h2>
        {step.body && <p>{step.body}</p>}
      </div>
      {actions && <div className="fx-next-actions">{actions}</div>}
    </section>
  );
}

/** Lane title, status and the facts that identify it: who, from where, how much changed. */
export function LaneHeader({
  lane,
  now,
  base,
  actions,
}: {
  lane: CockpitLane;
  now: number;
  base?: ReactNode;
  actions?: ReactNode;
}) {
  const actor =
    lane.session?.name ?? (lane.startedBy?.name !== 'Agent workflow' ? lane.startedBy?.name : undefined);
  return (
    <div className="fx-lane-head">
      <div className="fx-lane-head-main">
        <h1>
          <Glyph name="lane" size={18} />
          {displayLaneName(lane.name, lane.intent)}
          <StatusPill title={lane.queue?.tip} tone={lane.tone}>
            {lane.label}
          </StatusPill>
        </h1>
        <div className="fx-lane-meta">
          {actor ? (
            <span className="fx-meta-who" title={lane.session?.environment}>
              <Avatar
                name={actor}
                size="sm"
                kind={lane.session || lane.startedBy?.kind === 'agent' ? 'agent' : 'human'}
              />
              <b>{actor}</b>
              {lane.session && (
                <>
                  <Dot tone={lane.session.tone} /> seen {age(lane.session.lastSeen, now, true)}
                </>
              )}
            </span>
          ) : null}
          {base && <span>{base}</span>}
          {lane.changes?.add !== undefined && <DiffStat add={lane.changes.add} del={lane.changes.del ?? 0} />}
          {lane.changes && (
            <span>
              {lane.changes.files} {lane.changes.files === 1 ? 'file' : 'files'}
            </span>
          )}
          {lane.queue?.meta && <span>{lane.queue.meta}</span>}
          {lane.open && !lane.queue && !lane.runStatus && <span className="fx-faint">No check yet</span>}
          <span className={!lane.open ? 'fx-lane-progress-complete' : undefined}>
            <Rail lane={lane} dim={lane.session?.tone === 'stale' || !lane.open} />
          </span>
        </div>
      </div>
      {actions && <div className="fx-lane-head-actions">{actions}</div>}
    </div>
  );
}
