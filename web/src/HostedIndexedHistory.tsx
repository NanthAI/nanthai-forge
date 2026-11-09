// SPDX-License-Identifier: Apache-2.0
import type { Id } from '../../convex/_generated/dataModel';
import type { HostedEvent } from '../../src/work-types';
import { useResolvedWorkValue, type WorkIndexWorkspace } from './hosted-work-index';
type Context = { projectId: Id<'hostedProjects'>; workspace: WorkIndexWorkspace; enabled: boolean };
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
