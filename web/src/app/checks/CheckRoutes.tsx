// SPDX-License-Identifier: Apache-2.0
// Choosing the check that decides a landing, starting from the CI the project has (Item 0c9207b8). The first question
// is the CI itself: four answers drawn alike. The recorded check sets the initial answer, with main's files as
// a fallback for first-time setup. Every answer leads to a route that works today: GitHub Actions to its workflows
// (OwnFile.tsx), any other CI to a machine you run, no CI to one command. Who pays and what a pass proves are said for
// the route in front of the person, not for all of them. Reads: use-workflows.ts, only while this chooser is open.
import { useState } from 'react';
import type { Id } from '../../../../convex/_generated/dataModel';
import { Band, Row } from '../../ds';
import { hrefFor, type AppRoute } from '../paths';
import type { SetupView } from '../start/setup-model';
import { CI_ORDER, ciFact, ciPreferred, ciTitles, type Ci } from './ci';
import { OwnFile } from './OwnFile';
import { useWorkflows } from './use-workflows';

type ProjectRoute = Extract<AppRoute, { frame: 'project' }>;
const DOCS = '/docs/operations';

/** A route set up from a terminal: what it is, who pays, what a pass proves, and where the steps are. */
function Route({ kind }: { kind: 'forge' | 'machine' }) {
  const forge = kind === 'forge';
  return (
    <Row cols="minmax(0, 1fr) auto">
      <div>
        <div className="ttl">
          {forge ? 'Forge’s check workflow, on your GitHub Actions' : 'A machine you run'}
        </div>
        <div className="meta">
          {forge
            ? 'One command that must pass; Forge runs only the tests a change can affect. You pay GitHub for the minutes.'
            : 'nforge worker runs one command that must pass, on your own hardware. A pass has that machine’s user rights; it is not a sandbox.'}
        </div>
      </div>
      <a
        className="btn sm ghost"
        href={`${DOCS}/${forge ? 'github-actions-checks' : 'self-hosted-runner'}/`}
        aria-label={`How to set up ${forge ? 'Forge’s check workflow' : 'a machine you run'}`}
      >
        How to set it up
      </a>
    </Row>
  );
}

/** The CI question and the chosen answer's next step. Shown to the owner while no check is chosen, or on Change. */
export function CheckRoutes(props: {
  projectId: Id<'hostedProjects'>;
  route: ProjectRoute;
  mainHead: string | null | undefined;
  mirror: string | null;
  check: SetupView['check'];
  onDone: () => void;
}) {
  const { result, retry } = useWorkflows(props.projectId, props.mainHead, true);
  const [picked, setPicked] = useState<Ci | undefined>();
  const found = result.kind === 'found' ? result : null;
  const workflows = found?.found.length ?? 0;
  const { check } = props;
  const current =
    check?.kind === 'forge-runner'
      ? { path: '.github/workflows/forge-check.yml', repository: check.repository, dispatched: true }
      : check?.kind === 'ci-file'
        ? { path: check.workflow, repository: check.repository, dispatched: false }
        : null;
  // A file read can suggest a choice only when the project has no recorded check.
  const recorded = current ? 'github' : check ? 'other' : undefined;
  const suggested = found
    ? ciPreferred(found.files, workflows, found.complete)
    : props.mainHead === null
      ? 'none'
      : undefined;
  const ci = picked ?? recorded ?? suggested;
  const project = props.route.project;
  return (
    <>
      <Band title="Which CI do you have?" hint="Forge runs no tests itself" />
      <div role="radiogroup" aria-label="Which CI do you have">
        {CI_ORDER.map(id => {
          const fact = found ? ciFact(id, found.files, workflows) : '';
          return (
            <button
              type="button"
              key={id}
              role="radio"
              className="row choice"
              aria-checked={ci === id}
              onClick={() => setPicked(id)}
            >
              <span className="rd" aria-hidden="true" />
              <span>
                <b>{ciTitles[id]}</b>
                {fact ? (
                  <span className="sub" translate="no">
                    {fact}
                  </span>
                ) : null}
              </span>
              <span />
            </button>
          );
        })}
      </div>
      {ci === 'github' ? (
        <>
          <OwnFile
            projectId={props.projectId}
            project={project}
            noMain={props.mainHead === null}
            result={result}
            retry={retry}
            mirror={props.mirror}
            current={current}
            mirrorHref={hrefFor({ ...props.route, section: 'mirror', rest: '' })}
            onDone={props.onDone}
          />
          <Band title="Or one command instead of a workflow" />
          <Route kind="forge" />
        </>
      ) : ci === 'gitlab' ? (
        <>
          <Band title="Where the check runs" />
          <p className="quietline">
            Forge cannot publish to GitLab yet, so a GitLab CI run cannot decide a landing. Until it can, the
            check runs on a machine you run.
          </p>
          <Route kind="machine" />
        </>
      ) : ci === 'other' ? (
        <>
          <Band title="Where the check runs" />
          <Route kind="machine" />
        </>
      ) : ci === 'none' ? (
        <>
          <Band title="Where one command runs" hint="name the command that must pass; pick where" />
          <Route kind="machine" />
          <Route kind="forge" />
        </>
      ) : null}
    </>
  );
}
