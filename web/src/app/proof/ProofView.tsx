// SPDX-License-Identifier: Apache-2.0
import { useState, type ReactNode } from 'react';
import type { checkEvidence } from '../../../../src/run-evidence';
import { checkRunState } from '../../../../src/check-run-state';
import { Glyph, Key, Region, Row, Who } from '../../ds';
import { Head } from '../Place';
import './proof.css';

type Check = NonNullable<ReturnType<typeof checkEvidence>>;
export type ProofData = {
  lane: { id: string; intentId: string; head: string; state: string };
  save: { id: string; head: string; at: string; author: string; notVerified?: string[] } | null;
  agentClient?: string | null;
  declaration?: {
    kind: 'landing';
    id: string;
    head: string;
    at: string;
    author: string;
    notVerified: string[];
  } | null;
  check: Check | null;
  claimMatchesCheck: boolean | null;
  currentHead: string | null;
  stale: boolean;
  landing?: {
    receiptId: string;
    head: string;
    candidateId: string;
    acceptedBy?: { kind: 'person' | 'auto'; actor?: string; note: string } | null;
  } | null;
  afterLandingCheck: { landings: number; minutes: number } | null;
};
const number = (value: number | null | undefined) =>
  value == null ? 'Not reported' : value.toLocaleString();
const time = (at: string) => new Date(at).toLocaleString();

function Fact({
  state,
  word,
  title,
  detail,
  source,
}: {
  state: 'passed' | 'failed' | 'active' | 'stale' | 'waiting';
  word: string;
  title: string;
  detail: ReactNode;
  source: string;
}) {
  return (
    <Row className="proof-row" cols="var(--proof-columns)">
      <span className="st" data-st={state}>
        <Glyph of={state} />
        {word}
      </span>
      <div>
        <div className="ttl any">{title}</div>
        <div className="meta any">{detail}</div>
      </div>
      <span className="src">{source}</span>
    </Row>
  );
}

/** Pure presentation: production supplies only retained records; browser tests inject fixtures here. */
export function ProofView({
  data,
  lanesHref,
  changeHref,
  recoveryHref,
  busy,
  message,
  error,
  onRunAll,
  onFollowups,
  reportDetails,
  onRevert,
}: {
  data: ProofData;
  lanesHref: string;
  changeHref: string;
  recoveryHref: string;
  busy?: boolean;
  message?: string;
  error?: string;
  onRunAll?: () => void;
  onFollowups?: (line?: number) => void;
  reportDetails?: ReactNode;
  onRevert?: () => void;
}) {
  const [shown, setShown] = useState(8);
  const { check } = data;
  const save = data.declaration ?? data.save;
  const claimKind = data.declaration ? 'landing' : 'save';
  const lines = save?.notVerified;
  const [app, model] = (data.agentClient ?? '').split(':');
  const state = check ? checkRunState({ status: check.status }) : null;
  const sentence = !check
    ? 'No check is recorded for this selection. Test execution is not reported.'
    : `${check.check}: ${state?.label ?? check.status}. ${check.files ? `${number(check.files.total)} test files reported by CI.` : 'Test-file execution was not reported.'}`;
  return (
    <>
      <Head trail={[{ label: 'Lanes', href: lanesHref }, { label: 'What was checked' }]} sentence={sentence}>
        {onRunAll && check ? (
          <Key disabled={busy} onClick={onRunAll}>
            Run every test now
          </Key>
        ) : null}
        {onRevert ? (
          <Key kind="ghost" disabled={busy} onClick={onRevert}>
            Take it out of main
          </Key>
        ) : null}
        <a className="btn ghost" href={changeHref}>
          The change itself
        </a>
      </Head>
      {error ? (
        <div className="notice" data-st="failed" role="alert">
          <Glyph of="failed" />
          {error}
        </div>
      ) : null}
      {message ? (
        <div className="quietline" role="status">
          {message}
        </div>
      ) : null}
      {data.stale ? (
        <div className="quietline">
          Current main is <code>{data.currentHead?.slice(0, 12)}</code>. This evidence stays on{' '}
          <code>{check?.head.slice(0, 12)}</code>; it does not establish coverage of current main.
        </div>
      ) : null}
      {check && data.landing && check.head !== data.landing.head ? (
        <div className="quietline">
          This check source differs from the accepted source. Coverage of the accepted source is not
          established by this read.
        </div>
      ) : null}
      <div className="proof-grid panes">
        <div className="pane proof-main">
          <Region title="What ran" hint="on the exact source named in the record">
            {check ? (
              <>
                <div className="proof-cover">
                  <span>Test files reported on this change</span>
                  <b className="num">{number(check.files?.total)}</b>
                </div>
                <Fact
                  state={
                    state?.tone === 'passed'
                      ? 'passed'
                      : state?.tone === 'failed'
                        ? 'failed'
                        : state?.tone === 'waiting'
                          ? 'waiting'
                          : state?.tone === 'running' || state?.tone === 'active'
                            ? 'active'
                            : 'stale'
                  }
                  word={state?.label ?? 'Not reported'}
                  title={`The check, ${check.check}`}
                  detail={
                    <>
                      {number(check.shards.completed)} of {number(check.shards.total)} shards completed
                      {check.files ? ` · ${number(check.files.failed)} test files reported failed` : ''}
                    </>
                  }
                  source="reported by your CI"
                />
                {check.files ? (
                  <Fact
                    state={check.files.failed ? 'failed' : 'passed'}
                    word={check.files.failed ? 'Failed' : 'Reported'}
                    title={`${number(check.files.total)} test files`}
                    detail="Counts and file timing come from the checked code. Total suite coverage is not reported."
                    source="self-reported via CI"
                  />
                ) : (
                  <p className="quietline">
                    The command outcome is recorded. No test-file report establishes which tests ran.
                  </p>
                )}
              </>
            ) : (
              <p className="quietline">No check recorded. Forge cannot say which tests ran.</p>
            )}
            {reportDetails}
          </Region>
          <Region title="What did not run" hint="a pass above says nothing about these">
            {check?.skipped ? (
              <Fact
                state="stale"
                word="Not run"
                title="Test shards"
                detail={check.skipped.reason}
                source="chosen by Forge"
              />
            ) : null}
            <p className="quietline">
              {check?.selection?.reason ?? 'Excluded tests and their reasons: not reported.'}
            </p>
            <Fact
              state="stale"
              word="Not reported"
              title="A full check of main after landing"
              detail={
                data.afterLandingCheck
                  ? `Configured after ${data.afterLandingCheck.landings} landings or ${data.afterLandingCheck.minutes} minutes. Execution on this exact source is not reported here.`
                  : 'No setting or execution evidence was supplied with this read.'
              }
              source={data.afterLandingCheck ? 'a project setting' : 'not reported'}
            />
          </Region>
          <Region
            title="Not verified, in the agent’s words"
            count={lines?.length || undefined}
            hint="a claim from the agent, not a check"
          >
            {save ? (
              <>
                {data.claimMatchesCheck === false ? (
                  <p className="quietline">
                    This claim belongs to this {claimKind} <code>{save.head.slice(0, 12)}</code>. Its coverage
                    of the composed check source is not established.
                  </p>
                ) : null}
                {lines === undefined ? (
                  <p className="quietline">
                    <b>Not reported.</b> No verification list accompanied this {claimKind}.
                  </p>
                ) : !lines.length ? (
                  <p className="quietline">
                    The agent sent an empty list: it claims it verified everything it changed. Forge cannot
                    check that claim.
                  </p>
                ) : (
                  <div className="proof-claims">
                    <div className="quote">
                      <div className="by">
                        <Who handle={save.author} />
                        <span>
                          wrote with the {claimKind} at {time(save.at)}
                        </span>
                      </div>
                      <ul>
                        {lines.slice(0, shown).map((line, index) => (
                          <li key={index}>
                            <span dir="auto">{line}</span>
                            {onFollowups ? (
                              <Key size="sm" disabled={busy} onClick={() => onFollowups(index)}>
                                Make it an Item
                              </Key>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div className="btns">
                      {shown < lines.length ? (
                        <Key size="sm" onClick={() => setShown(value => value + 50)}>
                          Show {Math.min(50, lines.length - shown)} more
                        </Key>
                      ) : null}
                      {onFollowups ? (
                        <Key size="sm" kind="ghost" disabled={busy} onClick={() => onFollowups()}>
                          Make all {lines.length} Items
                        </Key>
                      ) : null}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <p className="quietline">No saved claim is available.</p>
            )}
          </Region>
        </div>
        <div className="pane">
          <Region title={data.landing ? 'This landing' : 'This evidence'}>
            <dl className="kv">
              <dt>Item</dt>
              <dd>
                <code>{data.lane.intentId.slice(0, 12)}</code>
              </dd>
              <dt>Check</dt>
              <dd>{check?.check ?? 'No check recorded'}</dd>
              <dt>Selection</dt>
              <dd>{check?.selection?.effective ?? check?.selection?.mode ?? 'Not reported'}</dd>
              <dt>Test files</dt>
              <dd>
                {number(check?.files?.total)}
                {check?.files ? (
                  <small className="src proof-source">self-reported by checked code, via CI</small>
                ) : null}
              </dd>
              <dt>CI time</dt>
              <dd>
                {number(check?.ciMinutes)}
                {check?.ciMinutes == null ? '' : ' min'}
                {check?.ciMinutes == null ? null : (
                  <small className="src proof-source">reported by your CI</small>
                )}
              </dd>
              <dt>Wall time</dt>
              <dd>
                {number(check?.wallSeconds)}
                {check?.wallSeconds == null ? '' : ' s'}
                {check?.wallSeconds == null ? null : (
                  <small className="src proof-source">observed by Forge</small>
                )}
              </dd>
              <dt>Check source</dt>
              <dd>
                <code>{check?.head ?? 'Not reported'}</code>
              </dd>
              {data.landing ? (
                <>
                  <dt>Accepted source</dt>
                  <dd>
                    <code>{data.landing.head}</code>
                  </dd>
                </>
              ) : null}
              <dt>Claim source</dt>
              <dd>
                <code>{save?.head ?? 'Not reported'}</code>
              </dd>
              <dt>Agent app</dt>
              <dd>
                {app || 'Not reported'}
                {app ? <small className="src proof-source">reported by the agent</small> : null}
              </dd>
              <dt>Model</dt>
              <dd>
                {model || 'Not reported'}
                {model ? <small className="src proof-source">declared, not verified</small> : null}
              </dd>
              <dt>Tokens</dt>
              <dd>Not reported</dd>
              <dt>Approved by</dt>
              <dd>
                {data.landing?.acceptedBy ? (
                  <>
                    {data.landing.acceptedBy.kind === 'person' && data.landing.acceptedBy.actor ? (
                      <Who handle={data.landing.acceptedBy.actor} />
                    ) : null}
                    <span className="meta any">{data.landing.acceptedBy.note}</span>
                  </>
                ) : (
                  'Not reported'
                )}
              </dd>
            </dl>
            <div className="pf">
              <a className="lk" href={recoveryHref}>
                This Lane’s checks and recovery
              </a>
              {check?.providerLink ? (
                <>
                  {' '}
                  ·{' '}
                  <a className="lk" href={check.providerLink} target="_blank" rel="noreferrer">
                    Provider log
                  </a>
                </>
              ) : null}
            </div>
          </Region>
        </div>
      </div>
    </>
  );
}
