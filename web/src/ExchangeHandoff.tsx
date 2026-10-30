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
  transport,
  inline = false,
}: {
  projectId: Id<'hostedProjects'>;
  backupId: string;
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
