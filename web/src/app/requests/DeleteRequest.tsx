// SPDX-License-Identifier: Apache-2.0
// A request to delete many projects for good (Item 7456856f), at /account?request=ID: the whole frozen list first,
// then what goes and the typed count. Only the owner person approves, once; the server re-checks every project and
// skips any that changed. One subscription (projectDeleteRequests:read), which the server writes on the decision and
// once per project as its purge ends; nothing polls. Loaded with its route only.
import { useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import { Key, Region, Row, State, type StateWord } from '../../ds';
import { useSafeQuery } from '../../safe-query';
import { Head } from '../Place';
import { hrefFor } from '../paths';
import { bytesText, requestView, rowState, type DeleteRequestRead, type RequestProject } from './model';
import './requests.css';

const read = makeFunctionReference<'query', { requestId: string }, string>('projectDeleteRequests:read');
const decide = makeFunctionReference<
  'mutation',
  {
    requestId: string;
    operationId: string;
    decision: 'approve' | 'decline';
    kept?: string[];
    count?: number;
    reason?: string;
  },
  string
>('projectDeleteRequests:decide');
const retry = makeFunctionReference<'mutation', { requestId: string }, string>('projectDeleteRequests:retry');
/** Rows shown before "Show all" (DESIGN.md: long lists open in place). */
const CAP = 10;

const TONE_WORD: Record<string, StateWord> = {
  passed: 'Done',
  failed: 'Check failed',
  stale: 'Set aside',
  active: 'In progress',
  waiting: 'Needs you',
};

export default function DeleteRequest({
  requestId,
  alternate,
}: {
  requestId: string;
  alternate?: { href: string; label: string };
}) {
  const live = useSafeQuery(read, { requestId });
  const value = useMemo(() => {
    try {
      return live.value === undefined ? undefined : (JSON.parse(live.value) as DeleteRequestRead);
    } catch {
      return null;
    }
  }, [live.value]);
  const trail = [
    { label: 'Your projects', href: hrefFor({ frame: 'account', place: 'projects' }) },
    { label: 'Delete request' },
  ];
  const signInLink = alternate ? <a href={alternate.href}>{alternate.label}</a> : null;
  if (live.error || value === null)
    return (
      <Head trail={trail} sentence="This request was not found, or it belongs to another account.">
        {signInLink}
      </Head>
    );
  if (value === undefined) return <Head trail={trail} sentence="Loading the request…" />;
  return <RequestPage key={value.id} read={value} trail={trail} signInLink={signInLink} />;
}

export function RequestPage({
  read: request,
  trail,
  signInLink,
  actions,
}: {
  read: DeleteRequestRead;
  trail: { label: string; href?: string }[];
  signInLink?: ReactNode;
  /** For a test or a fixture page: the decision and retry calls (default: the live mutations). */
  actions?: {
    decide: (args: Parameters<ReturnType<typeof useDecide>>[0]) => Promise<unknown>;
    retry: () => Promise<unknown>;
  };
}) {
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
  const [typed, setTyped] = useState('');
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const live = useDecide(request.id);
  const liveRetry = useMutation(retry);
  const call = actions?.decide ?? live;
  const again = actions?.retry ?? (() => liveRetry({ requestId: request.id }));
  const view = requestView(request, kept, typed);
  const input = useRef<HTMLInputElement>(null);
  // One operation id per decision, so a retry after an unknown reply is the same decision.
  const operation = useRef(crypto.randomUUID());
  const run = async (what: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await what();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Forge did not answer. Nothing changed; try again.');
    } finally {
      setBusy(false);
    }
  };
  const approve = (event: FormEvent) => {
    event.preventDefault();
    if (!view.confirmed) return input.current?.focus();
    void run(() =>
      call({ operationId: operation.current, decision: 'approve', kept: [...kept], count: view.count }),
    );
  };
  const toggle = (project: RequestProject) =>
    setKept(old => {
      const next = new Set(old);
      if (next.has(project.projectId)) next.delete(project.projectId);
      else next.add(project.projectId);
      return next;
    });
  const rows = all ? request.projects : request.projects.slice(0, CAP);
  const wrong = typed.trim() !== '' && !view.confirmed;
  return (
    <div className="delete-request">
      <Head
        trail={trail}
        sentence={
          <>
            <b>{view.sentence.bold}</b> {view.sentence.rest}
          </>
        }
      >
        {signInLink}
      </Head>
      <div className="req">
        <Region
          title="The list"
          weight={view.open ? 'act' : 'watch'}
          count={request.projects.length}
          hint={`as it was when made, largest first`}
        >
          <Row cols="minmax(0, 1.5fr) minmax(0, 1fr) auto auto auto" className="th" aria-hidden="true">
            <span>Project</span>
            <span>Where it is</span>
            <span>Last landing</span>
            <span>Holds</span>
            <span />
          </Row>
          {rows.map(project => {
            const state = rowState(project, kept);
            return (
              <Row
                key={project.projectId}
                cols="minmax(0, 1.5fr) minmax(0, 1fr) auto auto auto"
                className={kept.has(project.projectId) || project.outcome === 'changed' ? 'out' : undefined}
              >
                <span className="nm" dir="auto" translate="no">
                  {project.slug}
                </span>
                <span className="meta">{project.trash ? 'in the trash' : 'not in the trash'}</span>
                <span className="meta">
                  {project.lastLandingAt
                    ? new Date(project.lastLandingAt).toLocaleDateString('en-GB', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })
                    : 'never'}
                </span>
                <span className="meta num">{bytesText(project.bytes)}</span>
                <span className="r">
                  {state && (state.word !== 'Kept' || !view.open) ? (
                    <State word={TONE_WORD[state.tone ?? 'stale']!}>{state.word}</State>
                  ) : null}
                  {view.open ? (
                    <Key
                      size="sm"
                      kind="ghost"
                      onClick={() => toggle(project)}
                      aria-label={`${kept.has(project.projectId) ? 'Put back' : 'Keep'} ${project.slug}`}
                    >
                      {kept.has(project.projectId) ? 'Put back' : 'Keep'}
                    </Key>
                  ) : null}
                </span>
              </Row>
            );
          })}
          {request.projects.length > CAP && !all ? (
            <Row cols="minmax(0, 1fr) auto">
              <span className="meta">
                {(request.projects.length - CAP).toLocaleString('en')} more in this list
              </span>
              <Key size="sm" onClick={() => setAll(true)}>
                Show all {request.projects.length.toLocaleString('en')}
              </Key>
            </Row>
          ) : null}
          {view.open ? (
            <p className="pf">
              {kept.size ? `${kept.size.toLocaleString('en')} kept out of this approval. ` : ''}A kept project
              stays where it is; one in the trash is removed 90 days after it went there, unless someone
              restores it.
            </p>
          ) : null}
        </Region>
        <Region title={view.open ? 'What goes, for good' : 'The request'} weight="ref">
          {view.open ? (
            <ul className="lost">
              <li>
                <b>{bytesText(view.bytes)}</b> of files, saves and history
              </li>
              <li>
                Every Lane, Item, landing, check result and setting in{' '}
                {view.count === 1 ? 'that project' : 'those projects'}
              </li>
              {view.notInTrash ? (
                <li>
                  <b>
                    {view.notInTrash.toLocaleString('en')}{' '}
                    {view.notInTrash === 1 ? 'project is' : 'projects are'} not in the trash
                  </b>{' '}
                  and would go straight to deleted
                </li>
              ) : null}
            </ul>
          ) : null}
          <dl className="facts">
            <div>
              <dt>Asked by</dt>
              <dd>{request.byDevice ? 'an agent or device sign-in of your account' : 'you, on the web'}</dd>
            </div>
            <div>
              <dt>Matches</dt>
              <dd dir="auto">{request.selector}</dd>
            </div>
            <div>
              <dt>{request.status === 'requested' ? 'Expires' : 'Status'}</dt>
              <dd>
                {request.status === 'requested'
                  ? `${new Date(request.expiresAt).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })}, then nothing happens`
                  : request.status}
              </dd>
            </div>
          </dl>
          {view.open ? (
            <form className="confirm" onSubmit={approve} noValidate>
              <label htmlFor="req-count">Type the number of projects to delete</label>
              <input
                id="req-count"
                ref={input}
                className="inp"
                inputMode="numeric"
                autoComplete="off"
                value={typed}
                onChange={event => setTyped(event.target.value)}
                aria-invalid={wrong || undefined}
                aria-describedby="req-count-help"
              />
              <p id="req-count-help" className="meta">
                {wrong
                  ? `The list has ${view.count.toLocaleString('en')} to delete. You typed ${typed.trim()}. Count again, or keep some out.`
                  : 'It is the count at the top of this page. Typing it is the only confirmation.'}
              </p>
              <div className="btns">
                <Key type="submit" kind="danger" disabled={busy || !view.confirmed}>
                  Delete {view.count.toLocaleString('en')} {view.count === 1 ? 'project' : 'projects'} for
                  good
                </Key>
                <Key
                  disabled={busy}
                  onClick={() =>
                    void run(() => call({ operationId: operation.current, decision: 'decline' }))
                  }
                >
                  Decline the request
                </Key>
              </div>
            </form>
          ) : view.failed ? (
            <div className="btns">
              <Key kind="primary" disabled={busy} onClick={() => void run(again)}>
                Retry the {view.failed.toLocaleString('en')} that failed
              </Key>
            </div>
          ) : null}
          {error ? (
            <p className="err" role="alert">
              {error}
            </p>
          ) : null}
        </Region>
      </div>
    </div>
  );
}

function useDecide(requestId: string) {
  const mutate = useMutation(decide);
  return (args: { operationId: string; decision: 'approve' | 'decline'; kept?: string[]; count?: number }) =>
    mutate({ requestId, ...args });
}
