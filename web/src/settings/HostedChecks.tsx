// SPDX-License-Identifier: Apache-2.0
import type { Id } from '../../../convex/_generated/dataModel';
import type { WorkData } from '../../../src/work-types';
import type { HostedRunSummary } from '../../../src/work-hosted-summary';
import { useWorkRecord, useWorkRecords, type WorkIndexWorkspace } from '../hosted-work-index';
import { CopyCommand } from './CopyCommand';
import { ChecksList } from './ChecksList';
import { acceptanceChecks, checkCommand, type AcceptanceEvidence } from './checks-model';
type Check = WorkData['checks'][number];
export default function HostedChecks({
  projectId,
  workspace,
  owner = false,
}: {
  projectId: Id<'hostedProjects'>;
  workspace: WorkIndexWorkspace | null;
  owner?: boolean;
}) {
  const checks = useWorkRecords<Pick<Check, 'id' | 'name' | 'definition'>>(projectId, workspace, 'checks');
  const runs = useWorkRecords<HostedRunSummary>(projectId, workspace, 'runs');
  const moves = useWorkRecords<AcceptanceEvidence>(projectId, workspace, 'channelMoves');
  const hosted = useWorkRecords<AcceptanceEvidence>(projectId, workspace, 'hostedChannelMoves');
  const required = acceptanceChecks([...moves.records, ...hosted.records], runs.records);
  return (
    <>
      <h1>Checks</h1>
      <ChecksList
        checks={checks.records}
        runs={runs.records}
        required={required}
        loading={!checks.complete || !runs.complete || !moves.complete || !hosted.complete}
        command={check => <Command projectId={projectId} workspace={workspace} id={check.id} />}
      />
      {!owner && <p className="fx-muted fx-owner-note">Only owners can change this</p>}
      {owner && (
        <details className="fx-check-command">
          <summary>Define a check locally</summary>
          <CopyCommand
            command={`nforge agent /path/to/project define-check '{"name":"verify","executable":"npm","args":["run","verify"]}'`}
          />
        </details>
      )}
    </>
  );
}
function Command({
  projectId,
  workspace,
  id,
}: {
  projectId: Id<'hostedProjects'>;
  workspace: WorkIndexWorkspace | null;
  id: string;
}) {
  const check = useWorkRecord<Check>(projectId, workspace, 'checks', id);
  return check ? (
    <code className="fx-check-short-command" title={[check.executable, ...check.args].join(' ')}>
      {checkCommand(check.executable, check.args, [workspace?.name ?? '', workspace?.key ?? ''])}
    </code>
  ) : (
    <span className="fx-muted">…</span>
  );
}
