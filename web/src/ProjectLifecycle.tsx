// SPDX-License-Identifier: Apache-2.0
import { ErrorToast } from './ui/Toast';
import { useEffect, useRef, useState } from 'react';
import { useConvex } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api } from '../../convex/_generated/api';
import { hostedError } from './snapshot';

type Project = FunctionReturnType<typeof api.projectBackups.list>['page'][number];
type Operation = {
  kind: 'trash' | 'restore' | 'delete';
  projectId: Project['id'];
  operationId: string;
  expectedRevision: number;
  confirm?: string;
};
const day = (at: number) => new Date(at).toLocaleDateString(undefined, { dateStyle: 'medium' });
const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
export default function ProjectLifecycle({ project }: { project: Project }) {
  const client = useConvex(),
    dialog = useRef<HTMLDialogElement>(null),
    cancel = useRef<HTMLButtonElement>(null);
  const [confirm, setConfirm] = useState(false),
    [typed, setTyped] = useState(''),
    [busy, setBusy] = useState(false),
    [attempt, setAttempt] = useState<Operation | null>(null);
  const [slug, setSlug] = useState(project.slug ?? '');
  const [name, setName] = useState(project.name),
    [renameAttempt, setRenameAttempt] = useState<{
      projectId: Project['id'];
      operationId: string;
      expectedRevision: number;
      name: string;
      slug: string;
    } | null>(null);
  const [message, setMessage] = useState(''),
    [error, setError] = useState('');
  useEffect(() => {
    if (confirm) {
      dialog.current?.showModal();
      cancel.current?.focus();
    } else dialog.current?.close();
  }, [confirm]);
  async function run(operation: Operation) {
    setAttempt(operation);
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const { kind, ...input } = operation;
      await client.mutation(
        kind === 'trash'
          ? api.projectLifecycle.trash
          : kind === 'restore'
            ? api.projectLifecycle.restore
            : api.projectLifecycle.permanentlyDelete,
        input,
      );
      setAttempt(null);
      setConfirm(false);
      setTyped('');
      setMessage(
        kind === 'trash'
          ? 'Project deleted. You can restore it here for 90 days.'
          : kind === 'restore'
            ? 'Project restored with its source and Work. Grant access and register runners again.'
            : 'Permanent removal started. Its progress updates here.',
      );
    } catch (e) {
      setError(`${hostedError(e)} Retry the original operation to reconcile its outcome.`);
    } finally {
      setBusy(false);
    }
  }
  async function rename() {
    const input = renameAttempt ?? {
      projectId: project.id,
      operationId: crypto.randomUUID(),
      expectedRevision: project.revision,
      name,
      slug,
    };
    setRenameAttempt(input);
    setBusy(true);
    setError('');
    try {
      await client.mutation(api.projectLifecycle.rename, input);
      setRenameAttempt(null);
      setMessage('Project name updated.');
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setBusy(false);
    }
  }
  function start(kind: Operation['kind']) {
    void run({
      kind,
      projectId: project.id,
      operationId: crypto.randomUUID(),
      expectedRevision: project.revision,
      ...(kind === 'delete' ? { confirm: typed.trim() } : {}),
    });
  }
  const confirmation = project.slug ?? project.name,
    retention = project.retention,
    purge = project.purge;
  return (
    <section className="project-settings">
      <h2>Project settings</h2>
      {!project.removal && (
        <form
          onSubmit={e => {
            e.preventDefault();
            void rename();
          }}
        >
          <label>
            Project name
            <input
              required
              disabled={busy || !!renameAttempt}
              value={name}
              onChange={e => setName(e.target.value)}
            />
          </label>
          <label>
            Project slug
            <input
              required
              value={slug}
              disabled={busy || !!renameAttempt}
              onChange={event => setSlug(event.target.value)}
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
            />
          </label>
          <p>
            /{project.handle ?? 'your-handle'}/{slug} · Previous links keep working.
          </p>
          <button
            disabled={
              busy ||
              (!renameAttempt && (!name.trim() || (name.trim() === project.name && slug === project.slug)))
            }
          >
            {renameAttempt ? 'Retry original rename' : 'Save project name and URL'}
          </button>
          {renameAttempt && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setRenameAttempt(null);
                setName(project.name);
                setSlug(project.slug ?? '');
              }}
            >
              Use current name
            </button>
          )}
        </form>
      )}
      {project.removal === 'trash' && (
        <p>
          Deleted{project.removedAt ? ` ${day(project.removedAt)}` : ''}. Nobody can read or change it.
          {retention && ` Restorable until ${day(retention.purgeAt)}, then purged.`}
          {retention &&
            ` Retained: ${mib(retention.retainedBytes)} in ${retention.retainedObjects} objects${retention.measured ? '' : ' so far'}.`}
        </p>
      )}
      {project.removal === 'deleting' && (
        <p>
          Purging
          {purge
            ? `: ${purge.rows} records removed in ${purge.pages} pages (operation ${purge.operationId})`
            : ''}
          .{project.purgeBlocked ? ` Stopped: ${project.purgeBlocked}. Retry after it is resolved.` : ''}
        </p>
      )}
      {project.removal === 'deleted' && <p>Project permanently deleted.</p>}
      <div className="import-actions">
        {!project.removal && (
          <button disabled={busy || !!attempt} onClick={() => setConfirm(true)}>
            Delete project
          </button>
        )}
        {project.removal === 'trash' && (
          <>
            <button disabled={busy || !!attempt} onClick={() => start('restore')}>
              Restore project
            </button>
            <button disabled={busy || !!attempt} onClick={() => setConfirm(true)}>
              Delete permanently now
            </button>
          </>
        )}
        {project.removal === 'deleting' && !attempt && (
          <button disabled={busy} onClick={() => start('delete')}>
            Retry removal
          </button>
        )}
        {attempt && (
          <>
            <button disabled={busy} onClick={() => void run(attempt)}>
              Retry original operation
            </button>
            <button
              disabled={busy}
              onClick={() => {
                setAttempt(null);
                setError('');
              }}
            >
              Use current project state
            </button>
          </>
        )}
      </div>
      {message && (
        <p className="operation-result" role="status">
          {message}
        </p>
      )}
      {error && !confirm && <ErrorToast>{error}</ErrorToast>}
      <dialog
        ref={dialog}
        className="delete-confirmation"
        aria-labelledby="delete-project-title"
        onCancel={() => setConfirm(false)}
      >
        <h3 id="delete-project-title">Delete {project.name || 'this project'}?</h3>
        <p>
          The project is hidden at once. Reads, changes, Lanes, landings, runners and every grant stop. You
          can restore it for 90 days; grants and runner registrations are not restored. After 90 days its
          source, Work, backups and stored objects are purged. Local copies and GitHub are unchanged.
        </p>
        {!project.removal && (
          <button disabled={busy || !!attempt} onClick={() => start('trash')}>
            Delete project
          </button>
        )}
        <label>
          To delete permanently now, with no restore, type <strong>{confirmation}</strong>
          <input disabled={busy || !!attempt} value={typed} onChange={e => setTyped(e.target.value)} />
        </label>
        <button disabled={busy || !!attempt || typed.trim() !== confirmation} onClick={() => start('delete')}>
          Delete permanently now
        </button>
        <button disabled={busy} ref={cancel} onClick={() => setConfirm(false)}>
          Cancel
        </button>
        {attempt && (
          <button disabled={busy} onClick={() => void run(attempt)}>
            Retry original operation
          </button>
        )}
        {error && <ErrorToast>{error}</ErrorToast>}
      </dialog>
    </section>
  );
}
