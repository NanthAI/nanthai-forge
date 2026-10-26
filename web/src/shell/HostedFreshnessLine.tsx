// SPDX-License-Identifier: Apache-2.0
import { useGenerationFreshness } from '../ui/generation-freshness';
import { Tooltip } from '../ui/signals';
import { age } from '../ui/status';
import { useNow } from './StatusBar';

export function HostedFreshnessLine() {
  const { behind, catchingUp, value } = useGenerationFreshness();
  const now = useNow();
  if (!behind || !value) return null;
  const exact = (at: number | null | undefined) => (at == null ? 'unknown' : new Date(at).toISOString());
  return (
    <Tooltip
      className="fx-strip-freshness"
      content={
        <>
          Last hosted sync: {exact(value.syncedAt)}
          <br />
          Last owner-machine report:{' '}
          {exact(Math.max(value.ownerReport?.reportedAt ?? 0, value.machine?.reportedAt ?? 0) || null)}
          {value.ownerReport && value.ownerReport.revision > value.sourceRevision && (
            <>
              <br />
              Newer Work reported on the owner machine
            </>
          )}
          {value.push && (
            <>
              <br />
              {value.push.pending} · started {exact(value.push.startedAt)}
            </>
          )}
        </>
      }
    >
      {id => (
        <span tabIndex={0} aria-describedby={id}>
          Synced from {value.machine?.name || 'owner machine'}{' '}
          {value.syncedAt === null ? '(time unknown)' : age(value.syncedAt, now, true)}
          {catchingUp && ' · catching up'}
        </span>
      )}
    </Tooltip>
  );
}
