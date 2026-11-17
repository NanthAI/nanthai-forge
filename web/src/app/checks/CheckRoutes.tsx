// SPDX-License-Identifier: Apache-2.0
// Choosing the check that decides a landing, starting from the CI the project has (Item 0c9207b8). The routes are
// compared on the same facts (who pays for the minutes, what a pass proves); the project's own CI file is the one
// route set up here, the others from a terminal. For a CI file, the workflows on main are listed with what each runs
// on, the one trigger line it needs is shown as the exact change, and one press chooses it. Reads: the workflow list
// only while this chooser is open (use-workflows.ts); the press is choose-ci.ts's two reads and one write.
import { useRef, useState, type FormEvent } from 'react';
import { useConvex } from 'convex/react';
import type { Id } from '../../../../convex/_generated/dataModel';
import { Band, CodeBox, Key, Row } from '../../ds';
import { A } from '../frames';
import { hrefFor, type AppRoute } from '../paths';
import { CommandBlock } from '../start/parts';
import { chooseCiFile, triggerLine, workflowProblem } from './choose-ci';
import { useWorkflows } from './use-workflows';
import { cannotDecide, preferred, type FoundWorkflow, type TriggerChange } from './workflows';

type ProjectRoute = Extract<AppRoute, { frame: 'project' }>;
type CiRoute = 'own' | 'forge' | 'machine';
const DOCS = '/docs/operations';

const ROUTES: { id: CiRoute | 'other'; title: string; pays: string; proves: string }[] = [
  {
    id: 'own',
    title: 'Your own CI file, on GitHub Actions',
    pays: 'your GitHub Actions account',
    proves: 'GitHub’s own record that your whole workflow passed, on exactly what reaches main',
  },
  {
    id: 'forge',
    title: 'Forge’s check workflow, on your GitHub Actions',
    pays: 'your GitHub Actions account',
    proves: 'one command passed on exactly what reaches main; Forge runs only the tests a change can affect',
  },
  {
    id: 'machine',
    title: 'A machine you run',
    pays: 'you',
    proves: 'that command passed with that machine’s user rights; it is not a sandbox',
  },
  { id: 'other', title: 'Another CI provider', pays: '', proves: '' },
];

const short = (path: string) => path.split('/').at(-1) ?? path;

function Change({ path, change }: { path: string; change: TriggerChange }) {
  const line = (n: number | '', m: number | '', text: string, cls: string) => (
    <div className={`l ${cls}`}>
      <span className="n">{n}</span>
      <span className="n">{m}</span>
      <span className="c">{text}</span>
    </div>
  );
  return (
    <CodeBox label={`The change to ${path}`}>
      {change.before === null
        ? line('', change.line + 1, change.after, 'add')
        : [line(change.line, '', change.before, 'del'), line('', change.line, change.after, 'add')]}
    </CodeBox>
  );
}

function workflowSub(entry: FoundWorkflow) {
  const trigger = entry.trigger;
  if (!trigger) return 'Not opened: more workflow files than this page reads.';
  if (trigger.kind === 'unknown') return 'Forge could not tell what it runs on.';
  const no = cannotDecide(trigger);
  if (no || trigger.kind !== 'push') return no ?? '';
  const filter = trigger.paths
    ? ' It runs only when some paths change, so a landing that touches none is not checked.'
    : '';
  return `${trigger.covers ? 'Runs on push, including Forge’s branches.' : 'Runs on push. Needs one trigger line.'}${filter}`;
}

function TypedFile({ onUse, busy }: { onUse: (path: string) => void; busy: boolean }) {
  const [workflow, setWorkflow] = useState('.github/workflows/ci.yml');
  const [problem, setProblem] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const wrong = workflowProblem(workflow);
    setProblem(wrong);
    if (!wrong) onUse(workflow.trim());
  };
  return (
    <form className="pad gs-stack" onSubmit={submit} noValidate>
      <label className="gs-stack">
        <span className="ttl">Type the workflow file</span>
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
        <Key type="submit" disabled={busy}>
          Use this file
        </Key>
      </div>
    </form>
  );
}

function OwnFile({
  projectId,
  project,
  mainHead,
  mirror,
  mirrorHref,
  onDone,
}: {
  projectId: Id<'hostedProjects'>;
  project: string;
  mainHead: string | null | undefined;
  mirror: string | null;
  mirrorHref: string;
  onDone: () => void;
}) {
  const client = useConvex();
  const { result, retry } = useWorkflows(projectId, mainHead, true);
  const found = result.kind === 'found' ? result.found : [];
  const [picked, setPicked] = useState<string | undefined>();
  const chosen = picked ?? preferred(found);
  const entry = found.find(item => item.path === chosen);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const operation = useRef<{ id: string; workflow: string } | null>(null);
  const use = async (workflow: string) => {
    if (busy || !mirror) return;
    // The same id until the server answers, so a retry after a lost reply records one change.
    if (operation.current?.workflow !== workflow) operation.current = { id: crypto.randomUUID(), workflow };
    setBusy(true);
    setProblem('');
    try {
      await chooseCiFile(client, projectId, operation.current.id, mirror, workflow);
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
  const trigger = entry?.trigger?.kind === 'push' ? entry.trigger : null;
  return (
    <>
      <Band
        title="Which workflow must pass?"
        hint={found.length > 1 ? 'one decides; the others keep running as they do today' : undefined}
      />
      {mainHead === null ? (
        <p className="quietline">{project} has no main yet, so there is no workflow to read.</p>
      ) : result.kind === 'failed' ? (
        <p className="quietline">
          Forge could not list the workflows: {result.message}{' '}
          <Key size="sm" kind="ghost" onClick={retry}>
            Try again
          </Key>
        </p>
      ) : result.kind !== 'found' ? (
        <p className="quietline">Looking in {project}’s .github/workflows…</p>
      ) : found.length === 0 ? (
        <p className="quietline">
          {project} has no workflow file on main. Use Forge’s check workflow, or add one and type it below.
        </p>
      ) : (
        <div role="radiogroup" aria-label="Which workflow must pass">
          {found.map(item => {
            const no = item.trigger ? cannotDecide(item.trigger) : null;
            return (
              <button
                type="button"
                key={item.path}
                role="radio"
                className="row choice"
                aria-checked={chosen === item.path}
                disabled={!!no}
                onClick={() => setPicked(item.path)}
              >
                <span className="rd" aria-hidden="true" />
                <span>
                  <b className="mono" translate="no">
                    {item.path}
                  </b>
                  <span className="sub">{workflowSub(item)}</span>
                </span>
                <span />
              </button>
            );
          })}
        </div>
      )}
      {entry && trigger && !trigger.covers ? (
        <div className="pad gs-stack">
          <div className="meta t2">
            The one change it needs; nothing else in the file changes. Forge publishes each result it checks
            as a branch named forge/candidates/… on the mirror, and this makes your workflow run there. It
            lands as an ordinary change with your approval, because this file decides your checks.
          </div>
          {trigger.change ? (
            <Change path={entry.path} change={trigger.change} />
          ) : (
            <CommandBlock label="The trigger the CI file needs" text={triggerLine} />
          )}
        </div>
      ) : null}
      {!mirror ? (
        <p className="quietline">
          A CI file checks through the GitHub mirror, and it is off.{' '}
          <A href={mirrorHref}>Turn on the mirror</A>
        </p>
      ) : entry && !(entry.trigger && cannotDecide(entry.trigger)) ? (
        <div className="pad btns">
          <Key kind="rec" disabled={busy} onClick={() => void use(entry.path)}>
            {busy ? 'Choosing…' : `Use ${short(entry.path)}`}
          </Key>
          <span className="t3">Checks run on {mirror}. Its logs are as visible as that repository.</span>
        </div>
      ) : null}
      {problem ? (
        <p className="pad gs-err" role="alert">
          {problem}
        </p>
      ) : null}
      {mirror ? (
        <details className="gs-peek">
          <summary>A workflow that is not listed</summary>
          <TypedFile onUse={path => void use(path)} busy={busy} />
        </details>
      ) : null}
    </>
  );
}

/** The routes and the chosen route's next step. Shown to the owner while no check is chosen, or on Change. */
export function CheckRoutes(props: {
  projectId: Id<'hostedProjects'>;
  route: ProjectRoute;
  mainHead: string | null | undefined;
  mirror: string | null;
  onDone: () => void;
}) {
  const [picked, setPicked] = useState<CiRoute>('own');
  const mirrorHref = hrefFor({ ...props.route, section: 'mirror', rest: '' });
  return (
    <>
      <Band title="Which CI do you have?" hint="Forge runs no tests itself" />
      <div role="radiogroup" aria-label="Where the check runs">
        {ROUTES.map(item => (
          <button
            type="button"
            key={item.id}
            role="radio"
            className="row choice"
            aria-checked={picked === item.id}
            disabled={item.id === 'other'}
            onClick={() => item.id !== 'other' && setPicked(item.id)}
          >
            <span className="rd" aria-hidden="true" />
            <span>
              <b>{item.title}</b>
              {item.id === 'other' ? (
                <span className="sub">Not available yet.</span>
              ) : (
                <>
                  <span className="sub">Pays for the minutes: {item.pays}.</span>
                  <span className="sub">A pass proves {item.proves}.</span>
                </>
              )}
            </span>
            <span />
          </button>
        ))}
      </div>
      {picked === 'own' ? (
        <OwnFile
          projectId={props.projectId}
          project={props.route.project}
          mainHead={props.mainHead}
          mirror={props.mirror}
          mirrorHref={mirrorHref}
          onDone={props.onDone}
        />
      ) : (
        <Row cols="minmax(0, 1fr) auto">
          <div>
            <div className="ttl">Set up from a terminal</div>
            <div className="meta">
              {picked === 'forge'
                ? 'One command that must pass, run in shards on your GitHub Actions.'
                : 'nforge worker runs as a service on your own hardware and network.'}
            </div>
          </div>
          <a
            className="btn sm ghost"
            href={`${DOCS}/${picked === 'forge' ? 'github-actions-checks' : 'self-hosted-runner'}/`}
          >
            How to set it up
          </a>
        </Row>
      )}
    </>
  );
}
