// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Getting started on Needs me (Items 6beca32b, c3e4a838): the first things a new project needs, not a wizard. Each
// step says who did it and when, from the setup read (convex/projectSetup.ts); the line feed the frame already holds
// says whether a Lane is moving. Needs me supplies the reader's preferences from its existing FYI read; hidden
// projects don't subscribe. Automatic mode retires the checklist after the first landing and approval choice.
import { useEffect, useState } from 'react';
import { useConvex } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { AutonomyPolicy } from '../../../../src/autonomy-policy';
import { Key, Region, Row, State, Who } from '../../ds';
import { useSafeQuery } from '../../safe-query';
import { A } from '../frames';
import { hrefFor, type AppRoute } from '../paths';
import { agentAppsSummary, deploymentUrl, joinPrompt, manualSetupHref } from './agent-apps';
import { approvalWords, useApprovalWrite, type ApprovalMode } from './approvals';
import { ConnectSteps, CopyKey } from './parts';
import {
  askWhoApproves,
  gettingStartedShown,
  setupProgress,
  setupSteps,
  type SetupChange,
  type SetupPreferences,
  type SetupStep,
} from './setup-model';
import './start.css';

type ProjectRoute = Extract<AppRoute, { frame: 'project' }>;

function when(at: number) {
  const date = new Date(at);
  const today = new Date().toDateString() === date.toDateString();
  return today
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/** A per-browser note that this project's setup is settled; storage can be missing (private window). */
function recall(key: string) {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}
function remember(key: string) {
  try {
    localStorage.setItem(key, '1');
  } catch {
    // without storage the next visit reads once more
  }
}

function Tick({ state }: { state: SetupStep['state'] }) {
  if (state === 'moving') return <State word="Working" />;
  if (state === 'skipped') return <span className="ck" aria-hidden="true" />;
  return (
    <span
      className={state === 'done' ? 'ck on' : 'ck'}
      role="img"
      aria-label={state === 'done' ? 'Done' : 'Not done'}
    >
      {state === 'done' ? (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="m3 8.5 3.2 3.2L13 4.8" />
        </svg>
      ) : null}
    </span>
  );
}

function StepRow({
  step,
  route,
  change,
  busy,
}: {
  step: SetupStep;
  route: ProjectRoute;
  change: (change: SetupChange) => void;
  busy: boolean;
}) {
  const settings = (section: string) => hrefFor({ ...route, place: 'settings', section, rest: '' });
  const { id } = step;
  const skipped = step.state === 'skipped';
  const go =
    !skipped && step.id === 'github'
      ? { href: settings('mirror'), label: 'Open the mirror' }
      : step.id === 'check' && step.state === 'next'
        ? { href: settings('checks'), label: 'Choose' }
        : null;
  return (
    <Row
      weight={step.state === 'done' || skipped ? 'ref' : 'watch'}
      cols="auto minmax(0, 1fr) auto"
      className="gs-row"
    >
      <Tick state={step.state} />
      <div>
        <div className="ttl" dir="auto">
          {step.title}
        </div>
        <div className="meta" dir="auto">
          {skipped ? 'Skipped' : step.fact}
        </div>
      </div>
      <span className="gs-by">
        {!skipped && step.by ? <Who handle={`@${step.by}`} /> : null}
        {!skipped && step.at ? (
          <span className="num t3" title={new Date(step.at).toLocaleString()}>
            {when(step.at)}
          </span>
        ) : null}
        {go ? (
          <A className="btn sm" href={go.href}>
            {go.label}
          </A>
        ) : null}
        {id !== 'check' ? (
          <Key
            kind="ghost"
            size="sm"
            aria-label={`${skipped ? 'Undo skip' : 'Skip'}: ${step.title}`}
            aria-disabled={busy}
            onClick={() => change({ step: id, skip: !skipped })}
          >
            {skipped ? 'Undo' : 'Skip'}
          </Key>
        ) : null}
      </span>
    </Row>
  );
}

/** Asked once after the first landing: who approves the next ones. The answer is the setting itself. */
function WhoApproves({ projectId }: { projectId: Id<'hostedProjects'> }) {
  const client = useConvex();
  const write = useApprovalWrite(projectId);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const answer = async (mode: ApprovalMode) => {
    if (busy) return;
    setBusy(true);
    setProblem('');
    try {
      // The policy is read at the press, so the compare-and-swap is against what the server holds now.
      const expected = (await client.query(api.projectAutonomy.read, { projectId })) as AutonomyPolicy;
      await write(expected, mode);
    } catch {
      setProblem('The setting did not change. Nothing else changed either; try again.');
    } finally {
      setBusy(false);
    }
  };
  // a and b answer while this question is on screen, never inside a field, a dialog or with a modifier (rule 21).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target?.closest?.('input, textarea, select, [contenteditable], [role="dialog"]')
      )
        return;
      if (event.key === 'a') void answer('auto-on-pass');
      else if (event.key === 'b') void answer('review');
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });
  return (
    <article className="dec" data-weight="watch">
      <div className="dtop">
        <span>first landing on main</span>
        <span>asked once</span>
      </div>
      <h3>Who approves the next landings?</h3>
      <p className="why">
        With several agents, a person who approves each landing becomes the queue. Paths you protect still
        wait for you.
      </p>
      <div className="btns">
        <Key kind="rec" keys="a" disabled={busy} onClick={() => void answer('auto-on-pass')}>
          {approvalWords['auto-on-pass'].title}
        </Key>
        <Key keys="b" disabled={busy} onClick={() => void answer('review')}>
          {approvalWords.review.title}
        </Key>
      </div>
      {problem ? (
        <p className="gs-err" role="alert">
          {problem}
        </p>
      ) : null}
    </article>
  );
}

export default function GettingStarted({
  projectId,
  route,
  project,
  lanes,
  viewer,
  preferences,
  change,
  busy,
  headingRef,
}: {
  projectId: Id<'hostedProjects'>;
  route: ProjectRoute;
  project: string;
  /** Lanes on the line now (the frame's feed). */
  lanes: number;
  viewer: string;
  preferences: SetupPreferences;
  headingRef: (heading: HTMLHeadingElement | null) => void;
  change: (change: SetupChange) => void;
  busy: boolean;
}) {
  const client = useConvex();
  const memo = `forge.setup.settled.${projectId}.${viewer}`;
  const [settled, setSettled] = useState(() => recall(memo));
  const automatic = preferences.visibility === 'automatic';
  const live = preferences.visibility === 'shown' || (automatic && !settled);
  const { value: view, error } = useSafeQuery(
    api.projectSetup.read,
    live ? { projectId, checklist: true } : 'skip',
  );
  const finished = view !== undefined && !gettingStartedShown(view);
  useEffect(() => {
    if (!automatic || !finished) return;
    remember(memo);
    setSettled(true);
  }, [automatic, finished, memo]);
  if (error)
    return (
      <Region title="Getting started" weight="watch" headingRef={headingRef}>
        <p className="quietline">Getting started could not be read. Reload this page to try again.</p>
      </Region>
    );
  if (!view || (automatic && finished)) return null;
  const steps = setupSteps(view, project, lanes, preferences.skipped);
  const { done, total } = setupProgress(steps);
  const projectUrl = `${location.origin}/${route.handle}/${route.project}`;
  const agentNext = steps.some(step => step.id === 'agent' && step.state === 'next');
  return (
    <>
      <Region
        title="Getting started"
        weight="watch"
        headingRef={headingRef}
        hint={
          <span aria-live="polite">
            {done} of {total} done
          </span>
        }
      >
        {askWhoApproves(view) ? <WhoApproves projectId={projectId} /> : null}
        {steps.map(step => (
          <StepRow key={step.id} step={step} route={route} change={change} busy={busy} />
        ))}
        {agentNext ? (
          <div className="pad btns">
            <CopyKey
              text={joinPrompt(location.origin, projectUrl)}
              label="Give this to your agent"
              kind="rec"
            />
            <span className="t3">It joins {project} in its own Lane.</span>
          </div>
        ) : null}
        <p className="pf gs-later">
          <span className="t3">When ready:</span>
          <a href={manualSetupHref}>Quickstart</a>
          <A href={hrefFor({ ...route, place: 'settings', section: 'checks', rest: '' })}>
            Who approves landings
          </A>
          <A href={hrefFor({ ...route, place: 'settings', section: '', rest: '' })}>Invite a teammate</A>
          <Key kind="ghost" size="sm" aria-disabled={busy} onClick={() => change({ visibility: 'hidden' })}>
            Hide getting started
          </Key>
        </p>
      </Region>
      {agentNext ? (
        <Region
          title="Connect your agent app yourself"
          fold="start.connect"
          foldedByDefault
          sum={agentAppsSummary}
        >
          <ConnectSteps deployment={deploymentUrl()} project={projectUrl} connectionClient={client} />
        </Region>
      ) : null}
    </>
  );
}
