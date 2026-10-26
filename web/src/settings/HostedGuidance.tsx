// SPDX-License-Identifier: Apache-2.0
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import { GuidanceField } from '../shell/Guidance';
import { Panel } from '../ui/primitives';
import { hostedError } from '../snapshot';

/** "How I want agents to work" for a hosted project: project guidance (owner or maintainers) and personal. */
export default function HostedGuidance({ projectId }: { projectId: Id<'hostedProjects'> }) {
  const guidance = useQuery(api.agentGuidance.read, { projectId });
  const set = useMutation(api.agentGuidance.set);
  const save = (scope: 'project' | 'personal') => async (agentGuidance: string) => {
    try {
      await set({
        operationId: crypto.randomUUID(),
        scope,
        agentGuidance,
        ...(scope === 'project' ? { projectId } : {}),
      });
    } catch (e) {
      throw new Error(hostedError(e));
    }
  };
  return (
    <div className="fx">
      <div className="fx-page fx-settings">
        <Panel title="How I want agents to work">
          {!guidance ? (
            <p className="fx-loading">Reading guidance…</p>
          ) : (
            <>
              <GuidanceField
                label="For this project"
                hint="Included in every agent’s Forge briefing, after the repo’s AGENTS.md/CLAUDE.md."
                value={guidance.project}
                save={save('project')}
                {...(guidance.projectEditable
                  ? {}
                  : { disabled: 'Only the owner or a maintainer can change this.' })}
              />
              <GuidanceField
                label="Just for me"
                hint="Only for agents you start, in every project."
                value={guidance.personal}
                save={save('personal')}
              />
            </>
          )}
        </Panel>
      </div>
    </div>
  );
}
