// SPDX-License-Identifier: Apache-2.0
// Import from GitHub (`/new/import`, Items a488af2a, 2abda01f, c63c2171): one page, one ledger. The report reads
// what the import would (one action, about three GitHub requests, no rows written), then the person decides who can
// see it and whether GitHub keeps taking pushes, then one start. Progress is one subscription to the job, invalidated by
// import writes only; a GitHub rate limit offers "resume at the reset", which Forge runs on its own at that time. The
// request lives in the address, so a reload or a later visit shows the same import.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useConvex } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { ImportPreview, ImportVisibility } from '../../../../src/github-import-report';
import { Key, Region, Row, State } from '../../ds';
import { useSafeQuery } from '../../safe-query';
import { hostedError, hostedErrorCode } from '../../snapshot';
import { importAttemptAfterStartError } from '../../import-attempt';
import { A } from '../frames';
import { Head } from '../Place';
import { hrefFor } from '../paths';
import { navigate, useSearch } from '../router';
import { CommandBlock } from './parts';
import {
  bytes,
  clock,
  count,
  importCommand,
  importStage,
  mirrorAnswers,
  num,
  repositoryOf,
  visibilityWords,
  type ImportStage,
  type MirrorAnswer,
} from './import-model';
import './start.css';

type Attempt = { operationId: string; url: string; ref?: string; visibility?: 'private' };
type Preview = ImportPreview & { githubRequests?: unknown };
const trail = [
  { label: 'New project', href: hrefFor({ frame: 'bare', page: 'new' }) },
  { label: 'Import from GitHub' },
];

/** The request and job kept in the address: `?op=&url=&ref=&private=1&job=&mirror=one-way`. */
function fromSearch(search: URLSearchParams) {
  const operationId = search.get('op');
  const url = search.get('url');
  const attempt: Attempt | null =
    operationId && url
      ? {
          operationId,
          url,
          ...(search.get('ref') ? { ref: search.get('ref')! } : {}),
          ...(search.get('private') === '1' ? { visibility: 'private' as const } : {}),
        }
      : null;
  const job = search.get('job') as Id<'projectGithubImports'> | null;
  const mirror: MirrorAnswer = search.get('mirror') === 'one-way' ? 'one-way' : 'two-way';
  return { attempt, job: attempt ? job : null, mirror };
}
function remember(attempt: Attempt, job: string, mirror: MirrorAnswer) {
  const search = new URLSearchParams({ op: attempt.operationId, url: attempt.url, job });
  if (attempt.ref) search.set('ref', attempt.ref);
  if (attempt.visibility) search.set('private', '1');
  if (mirror === 'one-way') search.set('mirror', 'one-way');
  navigate(`${hrefFor({ frame: 'bare', page: 'import' })}?${search}`, { replace: true });
}

export default function ImportRepository() {
  const kept = fromSearch(useSearch());
  return kept.attempt && kept.job ? (
    <Running attempt={kept.attempt} job={kept.job} mirror={kept.mirror} />
  ) : (
    <Choose />
  );
}

function Choose() {
  const client = useConvex();
  const [url, setUrl] = useState('');
  const [ref, setRef] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [visibility, setVisibility] = useState<ImportVisibility | null>(null);
  const [mirror, setMirror] = useState<MirrorAnswer>('two-way');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  // One operation id until the server answers, so a retry after a lost reply starts one import.
  const attempt = useRef<Attempt | null>(null);
  const check = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !url.trim()) return;
    setBusy(true);
    setProblem('');
    try {
      const report = await client.action(api.projectGithubImportPreview.preview, {
        url: url.trim(),
        ...(ref.trim() ? { ref: ref.trim() } : {}),
      });
      setPreview(report);
      setVisibility(report.origin);
    } catch (error) {
      setPreview(null);
      setProblem(hostedError(error));
    } finally {
      setBusy(false);
    }
  };
  const start = async () => {
    if (!preview || busy) return;
    setBusy(true);
    setProblem('');
    attempt.current ??= {
      operationId: crypto.randomUUID(),
      url: url.trim(),
      ...(ref.trim() ? { ref: ref.trim() } : {}),
      // The default matches GitHub; only a different choice is sent.
      ...(visibility === 'private' && preview.origin === 'public' ? { visibility: 'private' as const } : {}),
    };
    try {
      const job = await client.action(api.projectGithubImport.start, attempt.current);
      remember(attempt.current, job, mirror);
    } catch (error) {
      attempt.current = importAttemptAfterStartError(attempt.current, hostedErrorCode(error));
      setProblem(hostedError(error));
    } finally {
      setBusy(false);
    }
  };
  const change = () => {
    setPreview(null);
    attempt.current = null;
    setProblem('');
  };
  const name = preview?.repository.split('/').at(-1) ?? '';
  return (
    <div className="gs">
      <Head
        trail={trail}
        sentence={
          preview
            ? `Bring ${name} across. History comes with it, and nothing changes on GitHub.`
            : 'Which repository? Paste its address. History comes with it, and nothing changes on GitHub.'
        }
      />
      {preview ? null : (
        <Region title="GitHub repository">
          <form className="pad gs-stack im-url" onSubmit={event => void check(event)}>
            <label className="f">
              Address
              <input
                className="inp"
                value={url}
                onChange={event => setUrl(event.target.value)}
                placeholder="https://github.com/OWNER/REPO"
                autoComplete="off"
                spellCheck={false}
                required
                aria-invalid={problem ? true : undefined}
              />
            </label>
            <label className="f">
              <span>
                Branch, tag or commit <span className="help">the default branch if empty</span>
              </span>
              <input
                className="inp"
                value={ref}
                onChange={event => setRef(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <div className="btns">
              <Key kind="primary" type="submit" disabled={busy || !url.trim()}>
                {busy ? 'Reading GitHub…' : 'Check it'}
              </Key>
            </div>
            {problem ? (
              <p className="gs-err" role="alert">
                {problem} Nothing was created.
              </p>
            ) : null}
          </form>
          <details className="gs-peek">
            <summary>From a terminal</summary>
            <CommandBlock
              label="The import command"
              text={`${importCommand(url.trim(), ref.trim(), null)} --preview`}
            />
          </details>
        </Region>
      )}
      {preview ? (
        <>
          <Region title="Comes across" hint={`${preview.repository}, ${preview.origin}, at ${preview.ref}`}>
            <Row cols="minmax(0, 1fr) auto">
              <span>
                {preview.files === null ? 'Every file' : count(preview.files, 'file')} at{' '}
                <code translate="no">{preview.commit.slice(0, 7)}</code>
                <span className="sub">
                  Binary files, executable bits and symlinks as they are.
                  {preview.submodules ? ` ${count(preview.submodules, 'submodule')} stay pointers.` : ''}
                </span>
              </span>
              <span className="t2">{preview.bytes === null ? '' : bytes(preview.bytes)}</span>
            </Row>
            <Row cols="minmax(0, 1fr)">
              <span>
                The full history
                <span className="sub">Same commit ids, so blame and old links still match GitHub.</span>
              </span>
            </Row>
            <Row cols="minmax(0, 1fr)">
              <span>
                Git LFS files
                <span className="sub">{preview.lfs}</span>
              </span>
            </Row>
            {preview.warnings.map(warning => (
              <Row key={warning.message} cols="auto minmax(0, 1fr)" className="gs-row">
                <State word="Needs you" state="waiting">
                  {warning.code ? 'Large' : 'Note'}
                </State>
                <span className="t2">{warning.message}</span>
              </Row>
            ))}
          </Region>
          <Region title="You decide" hint="both can change later">
            <div className="pad im-q">
              <b id="im-vis">Who can see it</b>
              <span className="sub">{visibilityWords(preview.origin, preview.choices)}</span>
            </div>
            {preview.choices.length > 1 ? (
              <div role="radiogroup" aria-labelledby="im-vis">
                {preview.choices.map(choice => (
                  <button
                    type="button"
                    key={choice}
                    role="radio"
                    className="row choice"
                    aria-checked={visibility === choice}
                    disabled={busy || !!attempt.current}
                    onClick={() => setVisibility(choice)}
                  >
                    <span className="rd" aria-hidden="true" />
                    <span>
                      <b>{choice === 'public' ? 'Public' : 'Private'}</b>
                      <span className="sub">
                        {choice === 'public'
                          ? 'Anyone can read it, as on GitHub.'
                          : 'Only you, and people you add.'}
                      </span>
                    </span>
                    <span />
                  </button>
                ))}
              </div>
            ) : null}
            <div className="pad im-q">
              <b id="im-mirror">Keep GitHub in sync both ways</b>
              <span className="sub">
                Asked once. The mirror is on either way; you allow it on GitHub after main is ready.
              </span>
            </div>
            <label className="row choice">
              <input
                type="checkbox"
                className="ckb"
                aria-labelledby="im-mirror"
                checked={mirror === 'two-way'}
                disabled={busy}
                onChange={event => setMirror(event.target.checked ? 'two-way' : 'one-way')}
              />
              <span>
                <b>{mirror === 'two-way' ? 'Yes' : 'No, Forge pushes only'}</b>
                <span className="sub">{mirrorAnswers[mirror].sub}</span>
              </span>
            </label>
            <div className="pad gs-stack">
              <div className="btns">
                <Key kind="primary" disabled={busy} onClick={() => void start()}>
                  {busy ? 'Starting…' : `Import ${name.length > 28 ? 'this repository' : name}`}
                </Key>
                <Key disabled={busy} onClick={change}>
                  Another repository or branch
                </Key>
              </div>
              {problem ? (
                <p className="gs-err" role="alert">
                  {problem}
                </p>
              ) : null}
            </div>
            <details className="gs-peek">
              <summary>From a terminal</summary>
              <CommandBlock
                label="The import command"
                text={importCommand(
                  url.trim(),
                  ref.trim(),
                  visibility === preview.origin ? null : visibility,
                )}
              />
            </details>
          </Region>
        </>
      ) : null}
    </div>
  );
}

function Running({
  attempt,
  job,
  mirror,
}: {
  attempt: Attempt;
  job: Id<'projectGithubImports'>;
  mirror: MirrorAnswer;
}) {
  const client = useConvex();
  const { value: progress, error: readError } = useSafeQuery(api.projectGithubImportProgress.current, {
    id: job,
  });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [project, setProject] = useState<{ href: string; id: Id<'hostedProjects'> } | null>(null);
  // The connect request's own operation id, kept until GitHub's page opens, so a retry asks once.
  const connectOperation = useRef(crypto.randomUUID());
  const name = attempt.url.replace(/\/+$/, '').split('/').at(-1) ?? 'the repository';
  // The render's clock decides whether a recorded reset is still ahead; it is never a query argument.
  const stage: ImportStage | null = progress ? importStage(progress, Date.now()) : null;
  const readyId = stage?.kind === 'ready' ? (stage.projectId as Id<'hostedProjects'>) : null;
  useEffect(() => {
    if (!readyId) return;
    let live = true;
    void client.query(api.urlProjects.resolve, { projectId: readyId }).then(found => {
      if (live && found)
        setProject({
          id: readyId,
          href: hrefFor({
            frame: 'project',
            handle: found.handle,
            project: found.slug,
            place: 'needs',
            section: '',
            rest: '',
          }),
        });
    });
    return () => {
      live = false;
    };
  }, [client, readyId]);
  const resume = async (atReset: boolean) => {
    setBusy(true);
    setProblem('');
    try {
      await client.action(api.projectGithubImport.start, {
        ...attempt,
        ...(atReset ? { atReset: true } : {}),
      });
    } catch (error) {
      setProblem(hostedError(error));
    } finally {
      setBusy(false);
    }
  };
  const allow = async () => {
    if (!project) return;
    setBusy(true);
    setProblem('');
    try {
      const approval = await client.action(api.githubBindingOAuth.connect, {
        projectId: project.id,
        operationId: connectOperation.current,
        repository: repositoryOf(attempt.url),
        ...(mirror === 'one-way' ? { oneWay: true } : {}),
      });
      location.assign(approval);
    } catch (error) {
      setProblem(hostedError(error));
      setBusy(false);
    }
  };
  const restart = () => navigate(hrefFor({ frame: 'bare', page: 'import' }), { replace: true });
  const files = (s: { done: number; total: number }) =>
    s.total ? `${num(s.done)} of ${count(s.total, 'file')}` : 'Reading the list of files';
  const sentence = !stage
    ? readError
      ? 'The import’s progress did not load. Reload to check on it; the import keeps running on Forge.'
      : `Importing ${name}.`
    : stage.kind === 'importing'
      ? `Importing ${name}. You can close this page: the import runs on Forge.`
      : stage.kind === 'paused'
        ? stage.scheduled
          ? `Paused by GitHub until ${clock(stage.at)}. Forge resumes this import then; you can close this page.`
          : `Paused until ${clock(stage.at)}. GitHub’s hourly limit for this import is reached. Nothing is lost.`
        : stage.kind === 'stopped'
          ? `${name} was not imported. ${stage.message}`
          : `${name} is on Forge. Main is ready.`;
  return (
    <div className="gs">
      <Head trail={[trail[0]!, { label: `Importing ${name}` }]} sentence={sentence} />
      {stage && stage.kind !== 'ready' ? (
        <Region
          title={stage.kind === 'stopped' ? 'Not imported' : 'Progress'}
          weight={stage.kind === 'importing' ? 'watch' : 'act'}
          waiting={stage.kind === 'importing' ? 0 : 1}
        >
          <Row cols="auto minmax(0, 1fr)" className="gs-row">
            {stage.kind === 'importing' ? (
              <State word="Working" />
            ) : stage.kind === 'paused' ? (
              <State word="Needs you" state="waiting">
                Paused by GitHub
              </State>
            ) : (
              <State word="Check failed" state="failed">
                Stopped
              </State>
            )}
            <span>
              {files(stage)} are across
              <span className="sub">
                {stage.kind === 'stopped'
                  ? `${stage.code}. Main is not published until every file arrives.`
                  : 'Main is published all at once, when every file has arrived.'}
              </span>
            </span>
          </Row>
          {stage.kind === 'paused' || stage.kind === 'stopped' ? (
            <div className="pad gs-stack">
              <div className="btns">
                {stage.kind === 'paused' && !stage.scheduled ? (
                  <Key kind="primary" disabled={busy} onClick={() => void resume(true)}>
                    Resume at {clock(stage.at)} for me
                  </Key>
                ) : null}
                {stage.kind === 'stopped' ? (
                  <Key kind="primary" disabled={busy} onClick={() => void resume(false)}>
                    Try again
                  </Key>
                ) : null}
                <Key disabled={busy} onClick={restart}>
                  Pick another repository
                </Key>
              </div>
              {problem ? (
                <p className="gs-err" role="alert">
                  {problem}
                </p>
              ) : null}
            </div>
          ) : null}
          <details className="gs-peek">
            <summary>From a terminal</summary>
            <CommandBlock
              label="The resume command"
              text={`nforge import --resume ${attempt.operationId}${stage.kind === 'paused' && !stage.scheduled ? ' --at-reset' : ''}`}
            />
          </details>
        </Region>
      ) : null}
      {stage?.kind === 'ready' ? (
        <Region title="Turn the mirror on" weight="act" waiting={1}>
          <div className="pad gs-stack">
            <p className="t2">
              {mirrorAnswers[mirror].sub} GitHub asks you once to allow Forge on this repository.
            </p>
            <div className="btns">
              <Key kind="primary" disabled={busy || !project} onClick={() => void allow()}>
                Allow on GitHub
              </Key>
              {project ? (
                <A className="btn" href={project.href}>
                  Open the project
                </A>
              ) : null}
            </div>
            {problem ? (
              <p className="gs-err" role="alert">
                {problem}
              </p>
            ) : null}
          </div>
        </Region>
      ) : null}
    </div>
  );
}
