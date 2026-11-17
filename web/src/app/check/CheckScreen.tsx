// SPDX-License-Identifier: Apache-2.0
// The landing check of one Lane (Items b030c3c5, 2c420916, 9e7a17df), the approved Failed check screen: the verdict and
// the next action in the head, the four suspects on the right, what failed and the facts on the left, the log one press
// away. One subscription (convex/projectFailureCause.ts forLane); every other read or write happens only on a press.
import { useState } from 'react';
import { useConvex } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { Glyph, Key, Region, Row, State } from '../../ds';
import { useSafeQuery } from '../../safe-query';
import { A } from '../frames';
import { hrefFor, type AppRoute } from '../paths';
import { Head } from '../Place';
import {
  agentPrompt,
  agentReply,
  checkSentence,
  duration,
  plural,
  suspectNames,
  verdictState,
  verdictWords,
  type CheckRead,
} from './check-model';
import { useCheckActions } from './use-check-actions';
import './check.css';

type ProjectRoute = Extract<AppRoute, { frame: 'project' }>;
const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

export default function CheckScreen({
  route,
  projectId,
  projectName,
  laneId,
}: {
  route: ProjectRoute;
  projectId: Id<'hostedProjects'>;
  projectName: string;
  laneId: string;
}) {
  const { value, error } = useSafeQuery(api.projectFailureCause.forLane, { projectId, laneId });
  const read = value ? (JSON.parse(value) as CheckRead) : null;
  const at = (patch: Partial<ProjectRoute>) => hrefFor({ ...route, ...patch });
  const trail = [
    { label: projectName, href: at({ place: 'needs', section: '', rest: '' }) },
    { label: 'Lanes', href: at({ section: '', rest: '' }) },
    { label: read?.title ?? laneId.slice(0, 8), href: at({ section: '', rest: laneId }) },
    { label: 'Landing check' },
  ];
  if (error)
    return (
      <Head trail={trail} sentence="Forge could not read this check. Nothing about the Lane changed.">
        <a className="btn sm" href={`/${route.handle}/${route.project}/lanes/${encodeURIComponent(laneId)}`}>
          Open the current Lane screen
        </a>
      </Head>
    );
  if (!read) return <Head trail={trail} sentence="Reading the check…" />;
  const proofHref = `${at({ rest: `${laneId}/checked` })}${read.run ? `?run=${encodeURIComponent(read.run.runId)}` : ''}`;
  return (
    <CheckView
      read={read}
      trail={trail}
      projectId={projectId}
      projectName={projectName}
      proofHref={proofHref}
    />
  );
}

export function CheckView({
  read,
  trail,
  projectId,
  projectName,
  proofHref,
}: {
  read: CheckRead;
  trail: { label: string; href?: string }[];
  projectId: Id<'hostedProjects'>;
  projectName: string;
  proofHref?: string;
}) {
  const client = useConvex();
  const actions = useCheckActions(client, projectId, read);
  const [cli, setCli] = useState(false);
  const verdict = verdictState(read);
  const sentence = checkSentence(read, clock);
  const recovery = read.cause?.next.recovery;
  return (
    <>
      <div className="head">
        <h1 className="crumb">
          {trail.map((crumb, index) => (
            <span key={index} className="crumb-step">
              {index ? (
                <span className="t3" aria-hidden="true">
                  /
                </span>
              ) : null}
              {crumb.href ? (
                <A href={crumb.href} className="cut" translate="no" dir="auto">
                  {crumb.label}
                </A>
              ) : (
                <span className="cut" aria-current="page">
                  {crumb.label}
                </span>
              )}
            </span>
          ))}
          <span className="right">
            <State word="Check failed" state={verdict.st}>
              {verdict.word}
            </State>
          </span>
        </h1>
        <p className="sit" aria-live="polite">
          <b>{sentence.lead}</b> {sentence.rest}
        </p>
        <div className="tools">
          <span className="btns">
            {proofHref ? (
              <A className="btn ghost" href={proofHref}>
                What was checked
              </A>
            ) : null}
            {recovery === 'fix-in-lane' || recovery === 'read-log' ? (
              <Key kind="rec" keys="a" onClick={() => actions.copy(agentPrompt(read, projectName))}>
                {actions.copied ? 'Copied' : 'Give this to your agent'}
              </Key>
            ) : null}
            {recovery === 'retry' ? (
              <Key kind="rec" keys="r" disabled={Boolean(actions.busy)} onClick={actions.retry}>
                {actions.busy === 'retry' ? 'Retrying the check…' : 'Retry the check'}
              </Key>
            ) : null}
            {read.landing?.state === 'landed' && read.landing.receiptId ? (
              <Key disabled={Boolean(actions.busy) || Boolean(actions.undone)} onClick={actions.undo}>
                {actions.busy === 'undo'
                  ? 'Taking it out of main…'
                  : actions.undone
                    ? 'Taken out, checking'
                    : 'Take it out of main'}
              </Key>
            ) : null}
            {read.run ? (
              <Key kind="ghost" aria-expanded={actions.log !== null} onClick={actions.readLog}>
                {actions.log === 'loading' ? 'Reading the log…' : 'Read the log'}
              </Key>
            ) : null}
          </span>
          <button
            type="button"
            className="cli"
            aria-controls="check-cli"
            aria-expanded={cli}
            title="What an agent gets"
            onClick={() => setCli(open => !open)}
          >
            <span className="mono">nforge agent . status</span>
          </button>
        </div>
      </div>
      <pre className="cli-out mono" id="check-cli" hidden={!cli}>
        {agentReply(read)}
      </pre>
      {actions.message ? (
        <div className="notice" data-st={actions.message.failed ? 'failed' : 'passed'} role="status">
          <p>{actions.message.text}</p>
        </div>
      ) : null}
      <div className="panes chk-p">
        <section className="pane" aria-label="Evidence">
          <Failed read={read} log={actions.log} />
          <Facts read={read} />
        </section>
        <section className="pane side" aria-label="Whose fault">
          <Suspects read={read} />
        </section>
      </div>
    </>
  );
}

function Failed({ read, log }: { read: CheckRead; log: string | null | 'loading' }) {
  const failing = read.cause?.failing ?? read.run?.failed ?? [];
  const count = read.cause?.failingCount ?? read.run?.files.failed ?? 0;
  const output =
    log && log !== 'loading' ? (
      <Region title="The log" hint="the failing output, as your CI sent it">
        <pre className="out mono" tabIndex={0}>
          {log || 'Your CI sent no output for this run.'}
        </pre>
      </Region>
    ) : null;
  if (!failing.length)
    return (
      <>
        {read.run?.failureReason ? (
          <Region title="What failed" hint="reported by your CI">
            <pre className="out mono" tabIndex={0}>
              {read.run.failureReason}
            </pre>
          </Region>
        ) : null}
        {output}
      </>
    );
  return (
    <>
      <Region
        title="What failed"
        count={count}
        hint={
          count > failing.length
            ? `${failing.length} of ${count}, in the order your CI reported`
            : 'reported by your CI'
        }
      >
        {failing.map(item => (
          <Row key={item.file} cols="auto minmax(0, 1fr)" className="ffile">
            <span className="st" data-st="failed">
              <Glyph of="failed" />
            </span>
            <span className="any">
              <span className="ttl mono cut" dir="auto" title={item.file}>
                {item.file}
              </span>
              {item.firstError ? <span className="meta wrap2">{item.firstError}</span> : null}
            </span>
          </Row>
        ))}
        {read.run && read.run.files.flaky ? (
          <p className="quietline">
            {plural(read.run.files.flaky, 'file')} failed, then passed on retry in this run.
          </p>
        ) : null}
      </Region>
      {output}
    </>
  );
}

function Suspects({ read }: { read: CheckRead }) {
  if (!read.cause)
    return (
      <Region title="Four suspects" hint="the change, the test, main, your CI">
        <p className="quietline">Nothing failed, so there is nothing to explain.</p>
      </Region>
    );
  return (
    <Region title="Four suspects" hint="the change, the test, main, your CI">
      {read.cause.suspects.map(item => {
        const hit = item.verdict === 'yes' || item.verdict === 'likely';
        return (
          <div
            key={item.suspect}
            className={hit ? 'sus hit' : 'sus'}
            data-st={
              hit
                ? item.suspect === 'ci' || read.cause!.cause === 'main-moved'
                  ? 'stale'
                  : 'failed'
                : undefined
            }
          >
            <div className="sh">
              <b>{suspectNames[item.suspect]}</b>
              <span className="v">{verdictWords[item.verdict]}</span>
            </div>
            <ul>
              {item.evidence.map(line => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        );
      })}
    </Region>
  );
}

function Facts({ read }: { read: CheckRead }) {
  const run = read.run;
  return (
    <Region title="Facts" quiet>
      <dl className="kv">
        <dt>Checks</dt>
        <dd>the exact result of this Lane on top of main</dd>
        <dt>Shards</dt>
        <dd className="num">{run?.timings.shards ?? <span className="t2">not reported</span>}</dd>
        <dt>Took</dt>
        <dd className="num">{run ? duration(run.timings.wallSeconds) : 'not reported'}</dd>
        <dt>CI used</dt>
        <dd className="num">
          {run?.cost ? duration(run.cost.seconds) : <span className="t2">not reported</span>}
        </dd>
        <dt>main</dt>
        <dd>
          {read.main?.redSince
            ? `failing since ${clock(read.main.redSince)}`
            : read.main?.result === 'passed'
              ? 'passed its last audit'
              : 'not reported'}
        </dd>
        <dt>Changed</dt>
        <dd>
          {read.lane
            ? `${plural(read.lane.count, 'file')}${read.lane.complete ? '' : ', list incomplete'}`
            : 'not reported'}
        </dd>
      </dl>
    </Region>
  );
}
