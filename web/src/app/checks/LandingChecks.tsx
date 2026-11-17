// SPDX-License-Identifier: Apache-2.0
// Settings > Landing and checks (Items 871e9b73, 0c9207b8): which check decides a landing, who approves landings and
// the landing mode in effect, with the one press that changes each. A fixed frame. It reads once when it opens (the
// setup read, the policy and the main audit's landing view: three calls) and again only after its own write; an open
// tab holds no subscription. Settings that have no effect are not offered as choices; Automatic settings appear once
// their engine (Item bd0f850e) is on main.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useConvex } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { AutonomyPolicy } from '../../../../src/autonomy-policy';
import type { LandingModeView } from '../../../../src/landing-mode';
import { Band, Key, Region, Row } from '../../ds';
import { crumbsFor, Head } from '../Place';
import type { AppRoute } from '../paths';
import { approvalWords, useApprovalWrite, type ApprovalMode } from '../start/approvals';
import { CommandBlock } from '../start/parts';
import { checkWords, type SetupView } from '../start/setup-model';
import { chooseCiFile, triggerLine, workflowProblem } from './choose-ci';
import '../start/start.css';

type ProjectRoute = Extract<AppRoute, { frame: 'project' }>;
const DOCS = '/docs';
type Facts = { setup: SetupView; policy: AutonomyPolicy; landing: LandingModeView | null };

function sentence(facts: Facts) {
  const { setup, policy } = facts;
  if (!setup.check) return 'Nothing can land yet: choose the check that decides a landing.';
  const check = checkWords(setup.check);
  return policy.acceptance.mode === 'review'
    ? `Each landing waits for a person after ${check} passes.`
    : `Checked work lands on its own when ${check} passes.`;
}

function CiFileForm({
  projectId,
  repository,
  changing,
  onDone,
}: {
  projectId: Id<'hostedProjects'>;
  repository: string;
  /** A check is already chosen: the form switches it. */
  changing: boolean;
  onDone: () => void;
}) {
  const client = useConvex();
  const [workflow, setWorkflow] = useState('.github/workflows/ci.yml');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const operation = useRef<{ id: string; workflow: string } | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const wrong = workflowProblem(workflow);
    setProblem(wrong);
    if (wrong || busy) return;
    // The same id until the server answers, so a retry after a lost reply records one change.
    if (operation.current?.workflow !== workflow) operation.current = { id: crypto.randomUUID(), workflow };
    setBusy(true);
    try {
      await chooseCiFile(client, projectId, operation.current.id, repository, workflow);
      operation.current = null;
      onDone();
    } catch (error) {
      setProblem(
        error instanceof Error && /mirror/i.test(error.message)
          ? 'Turn on the GitHub mirror first: a CI file checks Forge’s branches through it.'
          : 'The check did not change. Nothing else changed either; try again.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="pad gs-stack" onSubmit={event => void submit(event)} noValidate>
      <label className="gs-stack">
        <span className="ttl">
          {changing ? 'Use a different CI file' : 'Use the CI file you already have'}
        </span>
        <span className="meta t2">A workflow in {repository} that runs on push.</span>
        <input
          className="inp mono"
          value={workflow}
          onChange={event => setWorkflow(event.target.value)}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? 'ci-file-problem' : undefined}
        />
      </label>
      {problem ? (
        <p id="ci-file-problem" className="gs-err" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="btns">
        <Key kind="rec" type="submit" disabled={busy}>
          {busy ? 'Choosing…' : 'Use this file'}
        </Key>
      </div>
    </form>
  );
}

function Approvals({
  facts,
  projectId,
  onDone,
}: {
  facts: Facts;
  projectId: Id<'hostedProjects'>;
  onDone: () => void;
}) {
  const write = useApprovalWrite(projectId);
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
      <p className="quietline">
        {paths.length ? (
          <>
            Protected paths wait for a person: <code translate="no">{paths.join(', ')}</code>.
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

export default function LandingChecks({
  projectId,
  route,
  projectName,
}: {
  projectId: Id<'hostedProjects'>;
  route: ProjectRoute;
  projectName: string;
}) {
  const client = useConvex();
  const [facts, setFacts] = useState<Facts | null | 'failed'>(null);
  const [revision, setRevision] = useState(0);
  const [cli, setCli] = useState(false);
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
  const refresh = () => setRevision(value => value + 1);
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
          className="cli mono"
          aria-expanded={cli}
          aria-controls="checks-cli"
          onClick={() => setCli(!cli)}
        >
          <span>nforge agent . check-settings &#39;&#123;&#125;&#39;</span>
        </button>
      </Head>
      {cli ? (
        <pre className="cli-out mono" id="checks-cli">
          <b>$ nforge agent . check-settings &#39;&#123;&#125;&#39;</b>
          {'\n'}# prints the check definitions, the runner, who approves landings and what still blocks one
        </pre>
      ) : null}
      <Region
        title="The check that decides a landing"
        weight={!setup.check && owner ? 'act' : undefined}
        waiting={!setup.check && owner ? 1 : 0}
      >
        {setup.check ? (
          <Row cols="minmax(0, 1fr)">
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
              </div>
            </div>
          </Row>
        ) : (
          <p className="quietline">
            None yet. A landing needs a check that passes on exactly what reaches main.
          </p>
        )}
        {setup.check?.kind === 'ci-file' ? (
          <div className="pad gs-stack">
            <div className="meta t2">
              Its push branches need Forge’s branches. Your agent adds this in its first Lane:
            </div>
            <CommandBlock label="The trigger the CI file needs" text={triggerLine} />
          </div>
        ) : null}
        {owner && mirrorRepository ? (
          <CiFileForm
            projectId={projectId}
            repository={mirrorRepository}
            changing={!!setup.check}
            onDone={refresh}
          />
        ) : owner ? (
          <p className="quietline">
            To use your own CI file, turn on the GitHub mirror first:{' '}
            <a
              href={`/${encodeURIComponent(route.handle)}/${encodeURIComponent(route.project)}/settings/github`}
            >
              GitHub settings
            </a>
            .
          </p>
        ) : null}
        <Band title="Other ways to check" hint="set up from a terminal" />
        <Row cols="minmax(0, 1fr) auto">
          <div>
            <div className="ttl">Forge’s check workflow on GitHub Actions</div>
            <div className="meta">Runs only the tests a change can affect, in shards.</div>
          </div>
          <a className="btn sm ghost" href={`${DOCS}/operations/github-actions-checks/`}>
            How to set it up
          </a>
        </Row>
        <Row cols="minmax(0, 1fr) auto">
          <div>
            <div className="ttl">A machine you run</div>
            <div className="meta">For checks that need your own hardware or network.</div>
          </div>
          <a className="btn sm ghost" href={`${DOCS}/operations/self-hosted-runner/`}>
            How to set it up
          </a>
        </Row>
      </Region>
      <Approvals facts={facts} projectId={projectId} onDone={refresh} />
      {landing ? (
        <Region
          title="Landing mode"
          hint={landing.mode === landing.effective ? undefined : `set to ${landing.mode}`}
        >
          <Row cols="minmax(0, 1fr)">
            <div>
              <div className="ttl">{landing.label}</div>
              {landing.reason ? <div className="meta">{landing.reason}</div> : null}
            </div>
          </Row>
        </Region>
      ) : null}
    </div>
  );
}
