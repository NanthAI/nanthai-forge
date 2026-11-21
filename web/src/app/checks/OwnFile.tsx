// SPDX-License-Identifier: Apache-2.0
// GitHub Actions as the project's CI (Item 0c9207b8): the workflows on main with what each runs on, the one trigger
// line the chosen file needs shown as the exact change, and one press that chooses it (choose-ci.ts: two reads and one
// write). The list comes from the CI question's read (use-workflows.ts); this file reads nothing itself.
import { useRef, useState, type FormEvent } from 'react';
import { useConvex } from 'convex/react';
import type { Id } from '../../../../convex/_generated/dataModel';
import { Band, CodeBox, Key } from '../../ds';
import { A } from '../frames';
import { CommandBlock } from '../start/parts';
import { chooseCiFile, triggerLine, workflowProblem } from './choose-ci';
import type { Workflows } from './use-workflows';
import { cannotDecide, preferred, type Trigger, type TriggerChange } from './workflows';

const short = (path: string) => path.split('/').at(-1) ?? path;

export function Change({ path, change }: { path: string; change: TriggerChange }) {
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

function workflowSub(trigger: Trigger | null) {
  if (!trigger) return 'Not opened: more workflow files than this page reads.';
  if (trigger.kind === 'unknown') return 'Forge could not tell what it runs on.';
  const no = cannotDecide(trigger);
  if (no || trigger.kind !== 'push') return no ?? '';
  const filter = trigger.paths
    ? ' It runs only when some paths change, so a landing that touches none is not checked.'
    : '';
  return `${trigger.covers ? 'Runs on push, including Forge’s branches.' : 'Runs on push. Needs one trigger line.'}${filter}`;
}

function WorkflowChoice({
  path,
  fact,
  checked,
  disabled,
  onPick,
}: {
  path: string;
  fact: string;
  checked: boolean;
  disabled?: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      className="row choice"
      aria-checked={checked}
      disabled={disabled}
      onClick={onPick}
    >
      <span className="rd" aria-hidden="true" />
      <span>
        <b className="mono" translate="no">
          {path}
        </b>
        <span className="sub">{fact}</span>
      </span>
      <span />
    </button>
  );
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

export function OwnFile({
  projectId,
  project,
  noMain,
  result,
  retry,
  mirror,
  current,
  mirrorHref,
  onDone,
}: {
  projectId: Id<'hostedProjects'>;
  project: string;
  noMain: boolean;
  result: Workflows;
  retry: () => void;
  mirror: string | null;
  current: { path: string; repository: string | null; dispatched: boolean } | null;
  mirrorHref: string;
  onDone: () => void;
}) {
  const client = useConvex();
  const found = result.kind === 'found' ? result.found : [];
  const [picked, setPicked] = useState<string | null>();
  // Match the repository as well as the path. A separate runner repository can have its own copy.
  const onMirror = !!mirror && current?.repository?.toLowerCase() === mirror.toLowerCase();
  const currentFile = onMirror ? found.find(item => item.path === current?.path) : undefined;
  const alternatives = found.filter(
    item => item !== currentFile || (current?.dispatched && (!item.trigger || !cannotDecide(item.trigger))),
  );
  const chosen = picked === undefined ? (current ? null : preferred(found)) : picked;
  const entry =
    chosen === null
      ? current?.dispatched
        ? undefined
        : currentFile
      : alternatives.find(item => item.path === chosen);
  const canUse = chosen && entry && !(entry.trigger && cannotDecide(entry.trigger));
  const currentFact =
    current &&
    (current.dispatched
      ? 'Forge starts this workflow to check landings.'
      : currentFile
        ? workflowSub(currentFile.trigger)
        : '');
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
        hint={
          alternatives.length + Number(!!current) > 1
            ? 'one decides; the others keep running as they do today'
            : undefined
        }
      />
      {current || alternatives.length ? (
        <div role="radiogroup" aria-label="Which workflow must pass">
          {current ? (
            <WorkflowChoice
              path={current.path}
              fact={`${current.repository ? `Current check on ${current.repository}.` : 'Current check.'}${currentFact ? ` ${currentFact}` : ''}`}
              checked={chosen === null}
              onPick={() => setPicked(null)}
            />
          ) : null}
          {alternatives.map(item => (
            <WorkflowChoice
              key={item.path}
              path={item.path}
              fact={`${item.path === current?.path ? 'As a check through the mirror. ' : ''}${workflowSub(item.trigger)}`}
              checked={chosen === item.path}
              disabled={!!(item.trigger && cannotDecide(item.trigger))}
              onPick={() => setPicked(item.path)}
            />
          ))}
        </div>
      ) : null}
      {noMain ? (
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
        <p className="quietline">{project} has no workflow file on main.</p>
      ) : null}
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
          To choose a workflow that runs on push, turn on the GitHub mirror.{' '}
          <A href={mirrorHref}>Turn on the mirror</A>
        </p>
      ) : canUse ? (
        <div className="pad btns">
          <Key kind="rec" disabled={busy} onClick={() => void use(entry.path)}>
            {busy ? 'Choosing…' : `Use ${short(entry.path)}`}
          </Key>
          <span className="t3">
            Runs on {mirror}, on your GitHub Actions minutes. Its logs are as visible as that repository.
          </span>
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
