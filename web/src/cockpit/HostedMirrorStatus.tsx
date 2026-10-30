// SPDX-License-Identifier: Apache-2.0
import {
  hostedMirrorStatusText,
  type HostedMirrorStatus as Status,
} from '../../../src/hosted-github-mirror-status';
/** A recorded delivery problem stays visible while accepted Forge work proceeds. */
export function HostedMirrorStatus({ status, now }: { status?: Status | null; now: number }) {
  if (!status || (!status.lagging && !['failed', 'retrying'].includes(status.status))) return null;
  return (
    <p
      role="status"
      className="fx-situation"
      style={status.status === 'failed' ? { color: 'var(--failed)' } : undefined}
    >
      {hostedMirrorStatusText(status, now)}
    </p>
  );
}
