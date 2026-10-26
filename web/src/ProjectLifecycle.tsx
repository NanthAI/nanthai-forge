import { ErrorToast } from './ui/Toast';
// SPDX-License-Identifier: Apache-2.0
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
};
export default function ProjectLifecycle({ project }: { project: Project }) {
  const client = useConvex(),
    dialog = useRef<HTMLDialogElement>(null),
    cancel = useRef<HTMLButtonElement>(null);
  const [confirm, setConfirm] = useState(false),
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
      setMessage(
        kind === 'trash'
          ? 'Project moved to Trash. Your backups remain available to download.'
          : kind === 'restore'
            ? 'Project restored with its original source and Work.'
            : 'Permanent removal started. Its status updates here.',
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
    });
  }
  async function reconcile() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      let cursor: string | null = null;
      while (true) {
        const result: { cursor: string | null; isDone: boolean } = await client.mutation(
          api.projectLifecycle.reconcile,
          { projectId: project.id, cursor },
        );
        if (result.isDone) break;
        cursor = result.cursor;
      }
      setMessage(
        'Known original upload bindings reconciled. Unrelated files and downloaded copies remain unchanged.',
      );
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setBusy(false);
    }
  }
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
      <p>
        {project.removal === 'deleted'
          ? 'Project removed. Minimal owner and upload cleanup receipts remain for late outcomes.'
          : project.removal === 'deleting'
            ? 'Removing source, Work, backups and contributor access. Retry if cleanup was interrupted.'
            : project.removal === 'trash'
              ? 'In Trash. You can download retained backups. Contributors cannot access this project until you restore it.'
              : 'Trash keeps your source and Work for you to restore. It stops contributor access and source changes.'}
      </p>
      <div className="import-actions">
        {!project.removal && (
          <button disabled={busy || !!attempt} onClick={() => start('trash')}>
            Move to Trash
          </button>
        )}
        {project.removal === 'trash' && (
          <button disabled={busy || !!attempt} onClick={() => start('restore')}>
            Restore project
          </button>
        )}
        {!['deleting', 'deleted'].includes(project.removal ?? '') && (
          <button disabled={busy || !!attempt} onClick={() => setConfirm(true)}>
            Permanently delete project
          </button>
        )}
        {project.removal === 'deleting' && !attempt && (
          <button disabled={busy} onClick={() => start('delete')}>
            Retry removal
          </button>
        )}
        {project.removal === 'deleted' && (
          <button disabled={busy} onClick={() => void reconcile()}>
            Reconcile late uploads
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
        <h3 id="delete-project-title">Permanently delete {project.name || 'this project'}?</h3>
        <p>
          This removes hosted source, Work, retained backups, proposals and contributor grants. Your local
          projects, downloaded copies, GitHub and unrelated shared files remain unchanged. It cannot be
          restored.
        </p>
        <p>
          Minimal upload cleanup receipts remain. Previously issued provider upload URLs cannot be revoked;
          known late outcomes can be reconciled here.
        </p>
        <button disabled={busy || !!attempt} onClick={() => start('delete')}>
          Delete project permanently
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
