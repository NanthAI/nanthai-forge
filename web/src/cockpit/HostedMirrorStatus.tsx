// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { useMutation } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import {
  hostedMirrorStatusText,
  type HostedMirrorStatus as Status,
} from '../../../src/hosted-github-mirror-status';
import { Button } from '../ui/primitives';

/** Owner action for a stopped mirror: the same command as `nforge github resume`. */
export function useResumeMirror(projectId: Id<'hostedProjects'>) {
  const resume = useMutation(api.projectGithubMirrorResume.resume);
  return () => resume({ projectId });
}
/** A recorded delivery problem stays visible while accepted Forge work proceeds. The owner can
 * resume a stopped mirror from here when the status names that as its next step. */
export function HostedMirrorStatus({
  status,
  now,
  resume,
}: {
  status?: Status | null;
  now: number;
  resume?: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!status || (!status.lagging && !['failed', 'retrying'].includes(status.status))) return null;
  return (
    <>
      <p
        role="status"
        className="fx-situation"
        style={status.status === 'failed' ? { color: 'var(--failed)' } : undefined}
      >
        {hostedMirrorStatusText(status, now)}
      </p>
      {resume && status.status === 'failed' && status.nextStep ? (
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            resume()
              .catch(reason => setError(reason instanceof Error ? reason.message : 'Resume failed.'))
              .finally(() => setBusy(false));
          }}
        >
          Resume mirror
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="fx-situation">
          {error}
        </p>
      ) : null}
    </>
  );
}
