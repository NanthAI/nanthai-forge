// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Settings > Project > Backups (Item 966cb821): the project's stored checkpoints with Download and the recovery request,
// and, for the owner, storing an archive. Ported from the old project screen with the same
// server calls. One page of 10 checkpoints per open (a one-off read), more on a press; every action runs on a press.
import { useCallback, useEffect, useState } from 'react';
import { useConvex } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { hostedError } from '../../snapshot';
import { BackupsView } from './BackupsView';
import {
  downloadBackup,
  reconcile,
  recoveryRequest,
  storeArchive,
  type Backup,
  type Selected,
  type Upload,
} from './backup-actions';

const PAGE = 10;
type Page = { backups: readonly Backup[]; cursor: string | null };

export default function Backups({ projectId, owner }: { projectId: Id<'hostedProjects'>; owner: boolean }) {
  const client = useConvex();
  const [page, setPage] = useState<Page | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [upload, setUpload] = useState<Upload | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const read = useCallback(
    (from: string | null) => {
      void client
        .query(api.projectBackups.history, { projectId, paginationOpts: { cursor: from, numItems: PAGE } })
        .then(result => {
          setPage(was => ({
            backups: [...(from && was ? was.backups : []), ...result.page],
            cursor: result.isDone ? null : result.continueCursor,
          }));
          setFailed(false);
        })
        .catch(() => setFailed(true));
    },
    [client, projectId],
  );
  useEffect(() => read(null), [read]);
  /** The project's key and current backup, read when an archive is about to be stored, not on open. */
  const projectNow = async () => {
    const status = await client.query(api.projectBackups.deletionStatus, { projectId });
    if (!status) throw new Error('This project is unavailable with the current account.');
    return { key: status.key, name: status.name, currentBackup: status.currentBackup };
  };

  const run = async (task: () => Promise<string | null>) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const words = await task();
      if (words) setMessage(words);
    } catch (failure) {
      setError(hostedError(failure));
    } finally {
      setBusy(false);
    }
  };
  const choose = (file: File | undefined) =>
    run(async () => {
      setSelected(null);
      if (!file) return null;
      const { previewWorkArchive, archiveDigest } = await import('../../work-archive');
      setSelected({ file, preview: await previewWorkArchive(file), digest: await archiveDigest(file) });
      return null;
    });
  const store = (original: Upload) => {
    setUpload(original);
    return run(async () => {
      try {
        const words = await storeArchive(client, original);
        setUpload(null);
        setSelected(null);
        read(null);
        return words;
      } catch (failure) {
        if (original.id && (await reconcile(client, original.id).catch(() => false))) {
          setUpload(null);
          read(null);
          return 'Original uploaded bytes recovered and stored.';
        }
        throw new Error(
          `${hostedError(failure)} Original upload outcome is unresolved; reconcile before resuming.`,
        );
      }
    });
  };
  return (
    <BackupsView
      backups={page?.backups ?? null}
      failed={failed}
      more={!!page?.cursor}
      showMore={() => page?.cursor && read(page.cursor)}
      retry={() => read(null)}
      owner={owner}
      busy={busy}
      message={message}
      error={error}
      selected={selected}
      upload={upload}
      choose={file => void choose(file)}
      download={backup => void run(() => downloadBackup(client, backup))}
      recovery={backup => recoveryRequest(client.url, projectId, backup.id)}
      reconcileOne={backup =>
        void run(async () =>
          (await reconcile(client, backup.id))
            ? 'Original uploaded bytes recovered and stored.'
            : 'No complete original upload observed yet. Reconcile again or resume with the original archive.',
        )
      }
      resume={backup => {
        if (!selected || selected.digest !== backup.digest || selected.file.size !== backup.size) {
          setError('Select this original archive file to resume the same backup.');
          return;
        }
        void (async () => {
          try {
            const project = await projectNow();
            await store({
              file: selected.file,
              id: backup.id,
              input: {
                key: project.key,
                name: project.name,
                operationId: backup.operationId,
                previous: backup.previous,
                digest: backup.digest,
                size: backup.size,
                preview: backup.preview,
              },
            });
          } catch (failure) {
            setError(hostedError(failure));
          }
        })();
      }}
      start={() => {
        if (!selected) return;
        void (async () => {
          try {
            const project = await projectNow();
            await store({
              file: selected.file,
              input: {
                key: project.key,
                name: project.name,
                operationId: crypto.randomUUID(),
                previous: project.currentBackup,
                digest: selected.digest,
                size: selected.file.size,
                preview: selected.preview,
              },
            });
          } catch (failure) {
            setError(hostedError(failure));
          }
        })();
      }}
      resumeOriginal={() => upload && void store(upload)}
      dropOriginal={() => setUpload(null)}
      ready
    />
  );
}
