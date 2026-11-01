// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';
import { useConvex, useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { hostedError } from './snapshot';
import { ErrorToast } from './ui/Toast';

export default function ImportGithubProject({ created }: { created: (id: Id<'hostedProjects'>) => void }) {
  const client = useConvex();
  const [url, setUrl] = useState('');
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [id, setId] = useState<Id<'projectGithubImports'> | null>(null);
  // Retain the full original request on every retry, including worker errors.
  const attempt = useRef<{ operationId: string; url: string; ref?: string } | null>(null);
  const progress = useQuery(api.projectGithubImportProgress.current, id ? { id } : 'skip');
  const completed = useRef(false);
  useEffect(() => {
    if (progress?.phase === 'ready' && !completed.current) {
      completed.current = true;
      created(progress.projectId);
    }
  }, [progress, created]);
  async function submit() {
    setBusy(true);
    setError('');
    attempt.current ??= {
      operationId: crypto.randomUUID(),
      url: url.trim(),
      ...(ref.trim() ? { ref: ref.trim() } : {}),
    };
    try {
      setId(await client.action(api.projectGithubImport.start, attempt.current));
    } catch (error) {
      setError(hostedError(error));
    } finally {
      setBusy(false);
    }
  }
  const failed = progress?.phase === 'error';
  return (
    <form
      className="fx-new-project"
      onSubmit={event => {
        event.preventDefault();
        void submit();
      }}
    >
      {(error || progress?.error) && (
        <ErrorToast retry={() => void submit()}>{error || progress?.error?.message}</ErrorToast>
      )}
      <label htmlFor="github-project-url">GitHub repository URL</label>
      <input
        id="github-project-url"
        value={url}
        onChange={event => setUrl(event.target.value)}
        placeholder="https://github.com/owner/repository"
        required
        disabled={busy || !!attempt.current}
      />
      <label htmlFor="github-project-ref">Branch, tag or commit (optional)</label>
      <input
        id="github-project-ref"
        value={ref}
        onChange={event => setRef(event.target.value)}
        disabled={busy || !!attempt.current}
      />
      {id && (
        <p role="status">
          {progress
            ? `${progress.phase} · ${progress.completed} / ${progress.total} files`
            : 'Starting import…'}
        </p>
      )}
      <button className="fx-btn fx-btn-primary" disabled={busy || !url.trim() || (!!id && !failed)}>
        {busy ? 'Starting…' : attempt.current ? 'Resume import' : 'Import from GitHub'}
      </button>
    </form>
  );
}
