// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, useState } from 'react';
import { useConvex } from 'convex/react';
import type { Id } from '../../convex/_generated/dataModel';
import { api } from '../../convex/_generated/api';
import { PendingWrite } from './pending-write';
import { hostedError } from './snapshot';
import { ErrorToast } from './ui/Toast';

export default function NewHostedProject({
  created,
}: {
  created: (id: Id<'hostedProjects'>, source?: 'github') => void;
}) {
  const client = useConvex();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(
    new PendingWrite<{ name: string }, Id<'hostedProjects'>>(attempt =>
      client.action(api.projectBootstrap.create, { operationId: attempt.operationId, ...attempt.command }),
    ),
  );
  async function submit() {
    setBusy(true);
    setError('');
    try {
      const id = await pending.current.send({ name: name.trim() });
      setName('');
      created(id);
    } catch (error) {
      setError(hostedError(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <form
        className="fx-new-project"
        onSubmit={event => {
          event.preventDefault();
          void submit();
        }}
      >
        {error && (
          <ErrorToast fieldIds={['new-hosted-project-name']} retry={() => void submit()}>
            {error}
          </ErrorToast>
        )}
        <label htmlFor="new-hosted-project-name">Project name</label>
        <input
          id="new-hosted-project-name"
          value={name}
          onChange={event => setName(event.target.value)}
          required
          disabled={busy}
          aria-invalid={!!error}
        />
        <button className="fx-btn fx-btn-primary" disabled={busy || !name.trim()}>
          {busy ? 'Creating…' : pending.current.pending ? 'Retry creation' : 'Create project'}
        </button>
      </form>
      {/* The import page reports what comes across and asks who can see it before anything starts. */}
      <a className="fx-btn" href="/new/import">
        Import from GitHub
      </a>
    </>
  );
}

export function HostedProjectWelcome({
  addAgent,
  importSource,
  dismiss,
}: {
  addAgent: () => void;
  importSource: () => void;
  dismiss: () => void;
}) {
  return (
    <section className="fx-project-welcome" aria-label="Empty project">
      <h2>Your project is ready</h2>
      <p>main is empty. Add an agent to start work, or import a GitHub repository as a new project.</p>
      <div className="import-actions">
        <button className="fx-btn fx-btn-primary" onClick={addAgent}>
          Add an agent
        </button>
        <button className="fx-btn" onClick={importSource}>
          Import from GitHub
        </button>
        <button className="fx-btn fx-btn-ghost" onClick={dismiss}>
          Dismiss
        </button>
      </div>
    </section>
  );
}
