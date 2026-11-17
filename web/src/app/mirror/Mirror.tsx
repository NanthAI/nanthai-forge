// SPDX-License-Identifier: Apache-2.0
// Settings > GitHub mirror (Item c63c2171): the mirror in one sentence, the two ends (Forge main, GitHub main) with the
// distance between them, and one next action when a person must act. The words come from the same read as
// `nforge github status` (projectGithubMirrorRead.read: the project row and about three mirror rows), one subscription
// that re-runs on mirror or policy writes only. The owner changes direction with one switch (a set-policy write against
// the policy just read), resumes a stopped mirror, or allows Forge on GitHub when there is no mirror. Pausing and
// disconnecting stay CLI-only until their design is decided (G32).
import { useRef, useState } from 'react';
import { useConvex, useQuery } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { AutonomyPolicy } from '../../../../src/autonomy-policy';
import { Key, Region, Row, State } from '../../ds';
import { hostedError } from '../../snapshot';
import { crumbsFor, Head } from '../Place';
import type { PlaceProps } from '../screen-route';
import { CommandBlock } from '../start/parts';
import { endsWords, mirrorStateMark } from './mirror-model';
import '../start/start.css';
import './mirror.css';

export default function Mirror({ projectId, route, projectName }: PlaceProps) {
  const client = useConvex();
  const mirror = useQuery(api.projectGithubMirrorRead.read, { projectId });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [repo, setRepo] = useState('');
  const write = useRef<string | null>(null);
  const connect = useRef<string | null>(null);
  const project = `./${route.project}`;
  const run = async (task: () => Promise<unknown>) => {
    setBusy(true);
    setProblem('');
    try {
      await task();
    } catch (error) {
      setProblem(hostedError(error));
    } finally {
      setBusy(false);
    }
  };
  // Two-way on or off: the policy as read now, with only `inbound` changed; one id until the server answers.
  const turn = (inbound: boolean) =>
    run(async () => {
      const policy = (await client.query(api.projectAutonomy.read, { projectId })) as AutonomyPolicy;
      const current = policy.githubMirror;
      if (!current?.autoPush) return;
      write.current ??= crypto.randomUUID();
      await client.mutation(api.projectAutonomy.set, {
        projectId,
        command: JSON.stringify({
          action: 'set-policy',
          operationId: write.current,
          expectedPolicy: policy,
          githubMirror: { ...current, inbound },
        }),
      });
      write.current = null;
    });
  const allow = (repository: string, oneWay: boolean) =>
    run(async () => {
      connect.current ??= crypto.randomUUID();
      const approval = await client.action(api.githubBindingOAuth.connect, {
        projectId,
        operationId: connect.current,
        repository,
        ...(oneWay ? { oneWay: true } : {}),
      });
      location.assign(approval);
    });
  const resume = () => run(() => client.mutation(api.projectGithubMirrorResume.resume, { projectId }));
  if (mirror === undefined)
    return <Head trail={crumbsFor(route, projectName)} sentence="Reading the mirror…" />;
  const mark = mirrorStateMark(mirror.state);
  const ends = endsWords(mirror);
  const command = mirror.next?.replace(/ \. /, ` ${project} `) ?? null;
  return (
    <div className="mr">
      <Head trail={crumbsFor(route, projectName)} sentence={mirror.sentence} />
      <Region
        title="The two ends"
        weight={mirror.weight === 'reference' ? 'ref' : mirror.weight}
        waiting={mirror.weight === 'act' ? 1 : 0}
        hint={mirror.direction === 'off' ? 'mirror off' : `mirror on, ${mirror.direction}`}
      >
        <div className="mr-ends" data-st={mark.state}>
          <div className="mr-end">
            <span className="t2">Forge main</span>
            <code translate="no">{ends.forge}</code>
          </div>
          <div className="mr-gap" aria-label={`Between them: ${mark.gap}`}>
            <span className="mr-rule" aria-hidden="true" />
            <State word={mark.word} state={mark.state}>
              {mark.gap}
            </State>
            <span className="mr-rule" aria-hidden="true" />
          </div>
          <div className="mr-end">
            <span className="t2" translate="no">
              {mirror.repository ?? 'GitHub'} main, on GitHub
            </span>
            {ends.github ? <code translate="no">{ends.github}</code> : <span>not updated by Forge</span>}
            {ends.when ? <span className="t3">{ends.when}</span> : null}
          </div>
        </div>
        {mirror.ends?.detail ? <p className="quietline">{mirror.ends.detail}</p> : null}
        {command && mirror.weight === 'act' && mirror.state !== 'inbound-failed' && mirror.owner ? (
          <div className="pad gs-stack">
            <div className="btns">
              <Key kind="primary" disabled={busy} onClick={() => void resume()}>
                Resume the mirror
              </Key>
            </div>
            <p className="t2">
              Resume once GitHub’s main is the commit Forge pushed last, or the rule allows Forge.
            </p>
          </div>
        ) : null}
        {command && mirror.direction !== 'off' ? <p className="quietline">Next: {command}</p> : null}
      </Region>
      {mirror.direction === 'off' && mirror.owner ? (
        <Region title="Turn the mirror on" weight="ref">
          <form
            className="pad gs-stack"
            onSubmit={event => {
              event.preventDefault();
              const repository = (mirror.repository ?? repo).trim();
              if (repository) void allow(repository, false);
            }}
          >
            <p className="t2">
              With the mirror on, each landing pushes one commit to GitHub’s main, so GitHub stays a full copy
              you can leave with. GitHub asks you once to allow Forge.
            </p>
            {mirror.repository ? null : (
              <label className="f">
                GitHub repository
                <input
                  className="inp"
                  value={repo}
                  onChange={event => setRepo(event.target.value)}
                  placeholder="OWNER/NAME"
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
              </label>
            )}
            <div className="btns">
              <Key kind="primary" type="submit" disabled={busy}>
                Allow on GitHub
              </Key>
              <Key
                disabled={busy || !(mirror.repository ?? repo).trim()}
                onClick={() => void allow((mirror.repository ?? repo).trim(), true)}
              >
                One-way only
              </Key>
            </div>
          </form>
          <details className="gs-peek">
            <summary>From a terminal</summary>
            <CommandBlock
              label="The connect command"
              text={`nforge github connect ${project} --repo ${mirror.repository ?? 'OWNER/NAME'}`}
            />
          </details>
        </Region>
      ) : null}
      {mirror.direction !== 'off' ? (
        <Region title="Settings" hint={mirror.owner ? undefined : 'only the owner changes these'}>
          <Row cols="minmax(0, 1fr) auto">
            <span>
              Push each landing to GitHub
              <span className="sub">
                One commit to main, never a force push. Lanes and other branches are never written.
              </span>
            </span>
            <span className="t2">on</span>
          </Row>
          <Row cols="minmax(0, 1fr) auto">
            <label htmlFor="mr-inbound">
              Take GitHub pushes back in
              <span className="sub">
                A push or merge on GitHub main becomes a landing and passes the same check. Off: GitHub stays
                a copy and Forge stops instead of pushing over a change made there.
              </span>
            </label>
            <input
              id="mr-inbound"
              type="checkbox"
              role="switch"
              className="sw"
              checked={mirror.direction === 'two-way'}
              disabled={!mirror.owner || busy}
              onChange={event => void turn(event.target.checked)}
            />
          </Row>
          {problem ? (
            <p className="pad gs-err" role="alert">
              {problem}
            </p>
          ) : null}
        </Region>
      ) : problem ? (
        <p className="pad gs-err" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
