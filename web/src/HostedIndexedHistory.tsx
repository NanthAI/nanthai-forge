// SPDX-License-Identifier: Apache-2.0
import { SourceReference } from './SourceDiscussion';
import type { Id } from '../../convex/_generated/dataModel';
import type { HostedEvent, WorkData } from '../../src/work-types';
import { useResolvedWorkValue, type WorkIndexWorkspace } from './hosted-work-index';
type Context = { projectId: Id<'hostedProjects'>; workspace: WorkIndexWorkspace; enabled: boolean };
export function IndexedNote({
  projectId,
  workspace,
  enabled,
  item,
}: Context & { item: WorkData['intents'][number]['notes'][number] }) {
  const value = useResolvedWorkValue(projectId, workspace, 'notes', item, enabled);
  return value ? (
    <div className="work-note">
      <small>
        {value.kind} · {value.at}
      </small>
      {value.anchor && <SourceReference anchor={value.anchor} />}
      <p>{value.text}</p>
    </div>
  ) : (
    <p role="status">Loading entry…</p>
  );
}
export function IndexedEvent({ projectId, workspace, enabled, item }: Context & { item: HostedEvent }) {
  const value = useResolvedWorkValue(projectId, workspace, 'events', item, enabled);
  return value ? (
    <p>
      {value.command.action} · {value.at} · signed-in actor <code>{value.actor}</code> · original operation{' '}
      <code>{value.id}</code>
    </p>
  ) : (
    <p role="status">Loading operation…</p>
  );
}
