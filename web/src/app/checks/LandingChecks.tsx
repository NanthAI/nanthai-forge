// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Settings > Landing and checks (Items 871e9b73, 0c9207b8): which check decides a landing, who approves landings and
// the landing mode in effect, with the one press that changes each. A fixed frame. It reads once when it opens (the
// setup read, the policy and the main audit's landing view: three calls) and again only after its own write; an open
// tab holds no subscription. CheckRoutes starts from the setup read's check setting, and reads CI files on main
// for workflow facts and first-time setup. With a check chosen, one more read says whether it has decided a landing yet
// (FirstLanding.tsx), because a saved setting alone is not a connected CI. Settings that have no effect are not
// offered as choices. How a landing is checked is one folded line per setting, from the policy already read
// (LandingSettings.tsx); the Automatic and Manual switch appears once its engine (Item bd0f850e) is on main.
import { useEffect, useRef, useState } from 'react';
import { useConvex } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { AutonomyPolicy } from '../../../../src/autonomy-policy';
import type { LandingModeView } from '../../../../src/landing-mode';
import { Key, Region, Row } from '../../ds';
import { A } from '../frames';
import { hrefFor } from '../paths';
import { crumbsFor, Head } from '../Place';
import { approvalWords, useApprovalWrite, type ApprovalMode } from '../start/approvals';
import { landedAt } from '../code/code-words';
import { checkWords, type SetupView } from '../start/setup-model';
import type { PlaceProps } from '../screen-route';
import { CheckRoutes } from './CheckRoutes';
import { OwnerApprovalPaths } from './OwnerApprovalPaths';
import { LandingSettings } from './LandingSettings';
import { AwaitingFirstLanding, useFirstChecked } from './FirstLanding';
import { PendingWrite } from '../../pending-write';
import '../start/start.css';

type Facts = { setup: SetupView; policy: AutonomyPolicy; landing: LandingModeView | null };

function sentence(facts: Facts) {
  const { setup, policy } = facts;
  if (!setup.check)
    return setup.checkless
      ? 'Choose a check to require passing evidence on each landing.'
      : 'Choose the check that decides a landing.';
  const check = checkWords(setup.check);
  return policy.acceptance.mode === 'review'
    ? `Each landing waits for the owner after ${check} passes.`
    : `Checked work lands on its own when ${check} passes.`;
}

type ApprovalProps = {
  facts: Facts;
  projectId: Id<'hostedProjects'>;
  onDone: () => void;
};

function Approvals(props: ApprovalProps) {
  return <ProjectApprovals key={props.projectId} {...props} />;
}

function ProjectApprovals({ facts, projectId, onDone }: ApprovalProps) {
  const write = useApprovalWrite(projectId);
  const client = useConvex();
  const trustWrite = useRef<PendingWrite<
    { choice: 'enable' | 'keep'; expected: AutonomyPolicy },
    unknown
  > | null>(null);
  trustWrite.current ??= new PendingWrite(({ operationId, command }) =>
    client.mutation(api.projectAutonomy.set, {
      projectId,
      command: JSON.stringify({
        action: 'set-policy',
        operationId,
        expectedPolicy: command.expected,
        teamTrustChoice: command.choice,
      }),
    }),
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const owner = facts.setup.viewerIsOwner;
  const current = facts.policy.acceptance.mode;
  const pick = async (mode: ApprovalMode) => {
    if (!owner || busy || mode === current) return;
    setBusy(true);
    setProblem('');
    try {
      await write(facts.policy, mode);
      onDone();
    } catch {
      setProblem(
        'The setting did not change. Someone may have changed it a moment ago; the page shows it now.',
      );
      onDone();
    } finally {
      setBusy(false);
    }
  };
  const paths = facts.policy.acceptance.protectedPaths;
  const agents = facts.policy.acceptance.autoActors ?? [];
  const answerTrust = async (choice: 'enable' | 'keep') => {
    setBusy(true);
    setProblem('');
    try {
      await trustWrite.current!.send({ choice, expected: facts.policy });
      onDone();
    } catch {
      setProblem('The setting did not change. Reload the page and try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Region title="Who approves landings" hint={owner ? undefined : 'only the owner changes this'}>
      <div role="radiogroup" aria-label="Who approves landings">
        {(['review', 'auto-on-pass'] as const).map(mode => (
          <button
            type="button"
            key={mode}
            role="radio"
            className="row choice"
            aria-checked={current === mode}
            disabled={!owner || busy}
            onClick={() => void pick(mode)}
          >
            <span className="rd" aria-hidden="true" />
            <span>
              <b>{approvalWords[mode].title}</b>
              <span className="sub">{approvalWords[mode].sub}</span>
            </span>
            <span />
          </button>
        ))}
      </div>
      {problem ? (
        <p className="pad gs-err" role="alert">
          {problem}
        </p>
      ) : null}
      {facts.setup.offerEarnedTrust ? (
        <div className="pad">
          <p>Your project now has other members. Use earned trust for agent checks?</p>
          <p>Agents earn trust on the paths they change. Your agents skip the initial probation period.</p>
          <Key kind="rec" disabled={busy} onClick={() => void answerTrust('enable')}>
            Use earned trust
          </Key>{' '}
          <Key disabled={busy} onClick={() => void answerTrust('keep')}>
            Keep current policy
          </Key>
        </div>
      ) : null}
      <p className="quietline">
        {paths.length ? (
          <>
            Protected paths ask the owner: <code translate="no">{paths.join(', ')}</code>.
          </>
        ) : (
          'No protected paths.'
        )}
        {current === 'auto-on-pass' && agents.length
          ? ` Only these agents land on their own: ${agents.join(', ')}.`
          : ''}
      </p>
    </Region>
  );
}

export default function LandingChecks({ projectId, route, projectName, feed }: PlaceProps) {
  const client = useConvex();
  const [facts, setFacts] = useState<Facts | null | 'failed'>(null);
  const [revision, setRevision] = useState(0);
  const [cli, setCli] = useState(false);
  const [changing, setChanging] = useState(false);
  useEffect(() => {
    let live = true;
    void Promise.all([
      client.query(api.projectSetup.read, { projectId }),
      client.query(api.projectAutonomy.read, { projectId }),
      client.query(api.projectHostedMainAudit.status, { projectId }),
    ])
      .then(([setup, policy, audit]) => {
        const landing = (JSON.parse(audit) as { landing?: LandingModeView }).landing ?? null;
        if (live) setFacts({ setup: setup as SetupView, policy: policy as AutonomyPolicy, landing });
      })
      .catch(() => live && setFacts(previous => (previous && previous !== 'failed' ? previous : 'failed')));
    return () => {
      live = false;
    };
  }, [client, projectId, revision]);
  const refresh = () => {
    setChanging(false);
    setRevision(value => value + 1);
  };
  const chosen = facts && facts !== 'failed' ? facts.setup.check : null;
  const first = useFirstChecked(projectId, chosen?.chosenAt, revision);
  const trail = crumbsFor(route, projectName);
  if (facts === 'failed')
    return (
      <Head trail={trail} sentence="Forge could not read these settings. Nothing was changed.">
        <Key size="sm" onClick={refresh}>
          Try again
        </Key>
      </Head>
    );
  if (!facts) return <Head trail={trail} sentence="Reading the settings…" />;
  const { setup, landing } = facts;
  const owner = setup.viewerIsOwner;
  const mirrorRepository = setup.mirror?.repository ?? null;
  return (
    <div className="gs">
      <Head trail={trail} sentence={sentence(facts)}>
        <button
          type="button"
          className="cli"
          aria-expanded={cli}
          aria-controls="checks-cli"
          onClick={() => setCli(!cli)}
        >
          <span>Check settings for agents</span>
        </button>
      </Head>
      {cli ? (
        <pre className="cli-out mono" id="checks-cli" tabIndex={0}>
          <b>$ nforge agent . check-settings &#39;&#123;&#125;&#39;</b>
          {'\n'}# The owner chooses the check on this page.
          {'\n'}# Agents read the same settings with this command.
        </pre>
      ) : null}
      <Region
        title="The check that decides a landing"
        weight={!setup.check && owner ? 'act' : undefined}
        waiting={!setup.check && owner ? 1 : 0}
      >
        {setup.check ? (
          <Row cols="minmax(0, 1fr) auto">
            <div>
              <div className="ttl" dir="auto">
                {checkWords(setup.check)}
              </div>
              <div className="meta">
                {setup.check.kind === 'forge-runner' && setup.check.publicLogs
                  ? 'Check logs are public: anyone who can see that repository reads them.'
                  : setup.check.kind === 'machine'
                    ? 'It runs with that machine’s own rights.'
                    : 'Logs stay with GitHub, as visible as that repository.'}
                {first && first !== 'failed' ? (
                  <>
                    {' '}
                    First landing checked: <time dateTime={first.at}>{landedAt(first.at)}</time>.
                  </>
                ) : first === 'failed' ? (
                  ' Forge could not read whether it has checked a landing.'
                ) : null}
              </div>
            </div>
            {owner ? (
              <Key size="sm" kind="ghost" aria-expanded={changing} onClick={() => setChanging(!changing)}>
                {changing ? 'Keep it' : 'Change'}
              </Key>
            ) : null}
          </Row>
        ) : (
          <p className="quietline">
            None yet. A landing needs a check that passes on exactly what reaches main.
            {owner ? '' : ' Only the owner chooses it.'}
          </p>
        )}
        {setup.check && first === null && !changing ? (
          <AwaitingFirstLanding
            projectId={projectId}
            project={route.project}
            check={setup.check}
            feed={feed}
          />
        ) : null}
        {owner && (!setup.check || changing) ? (
          <CheckRoutes
            projectId={projectId}
            route={route}
            mainHead={feed === undefined ? undefined : (feed.main?.head ?? null)}
            mirror={mirrorRepository}
            check={setup.check}
            onDone={refresh}
          />
        ) : null}
      </Region>
      <Approvals facts={facts} projectId={projectId} onDone={refresh} />
      <OwnerApprovalPaths
        key={projectId}
        policy={facts.policy}
        projectId={projectId}
        owner={owner}
        onDone={refresh}
      />
      <LandingSettings policy={facts.policy} landing={landing} owner={owner} />
      {/* One line that points at the Secrets page (Item 41a0df87): static, so this page makes no extra read. */}
      <Region title="Secrets" hint="names only">
        <p className="quietline">Check and team secrets are listed by name, never by value.</p>
        <p className="quietline">
          <A className="lk" href={hrefFor({ ...route, section: 'secrets', rest: '' })}>
            Open Secrets
          </A>
        </p>
      </Region>
    </div>
  );
}
