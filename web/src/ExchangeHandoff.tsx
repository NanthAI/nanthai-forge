// SPDX-License-Identifier: Apache-2.0
import { useConvex } from 'convex/react';
import type { Id } from '../../convex/_generated/dataModel';
function download(value: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })),
    link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
export default function ExchangeHandoff({
  projectId,
  backupId,
  previous,
  revision,
  transport,
  inline = false,
}: {
  projectId: Id<'hostedProjects'>;
  backupId: string;
  previous?: string | null;
  revision?: number;
  transport?: 'objects';
  inline?: boolean;
}) {
  const client = useConvex();
  const contents = (
    <>
      <p>
        Forge sends missing source and artifact content once and reuses unchanged bytes across checkpoints.
        Source history remains retained.
      </p>
      <p>
        Run <code>nforge login {client.url}</code> and approve the device in Forge. Request files contain
        source pins, never credentials.
      </p>
      {transport === 'objects' && !inline && (
        <>
          <button onClick={() => download({ url: client.url, projectId, backupId }, 'forge-pull.json')}>
            Download incremental pull request
          </button>
          <p>
            <code>nforge exchange NEW_DIRECTORY pull --command-file forge-pull.json</code>. Add{' '}
            <code>cacheRoot</code> to reuse verified source from an existing owner and{' '}
            <code>journalPath</code> to include its matching hosted Work journal.
          </p>
        </>
      )}
      {revision !== undefined && (
        <>
          {transport === 'objects' && (
            <>
              <button
                onClick={() =>
                  download(
                    { url: client.url, projectId, backupId, operationId: crypto.randomUUID(), revision },
                    'forge-reconcile.json',
                  )
                }
              >
                Download Work reconciliation request
              </button>
              <p>
                Before returning edits from your existing owner, set its current local revision and run{' '}
                <code>nforge exchange ROOT reconcile --command-file forge-reconcile.json</code>. The original
                source and local Lane files remain in place.
              </p>
            </>
          )}
          <button
            onClick={() =>
              download(
                {
                  url: client.url,
                  projectId,
                  operationId: crypto.randomUUID(),
                  previous: previous ?? backupId,
                  revision,
                  returnSource: { expectedBackupId: backupId, revision, operationId: crypto.randomUUID() },
                },
                'forge-push.json',
              )
            }
          >
            Download incremental push request
          </button>
          <p>
            Set the top-level <code>revision</code> to the current local Work revision, then run{' '}
            <code>nforge exchange ROOT push --command-file forge-push.json</code>. Keep the original request
            for retries. The nested source-return pins preserve the observed hosted revision.
          </p>
        </>
      )}
      <p>
        Full recovery archives remain available through the local <code>export-work</code> command.
      </p>
    </>
  );
  return inline ? (
    contents
  ) : (
    <details className="collection-guide">
      <summary>Exchange changes with your local tools</summary>
      {contents}
    </details>
  );
}
