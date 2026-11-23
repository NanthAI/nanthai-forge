// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Settings > Agents (Item f2ee8381): the project's agent guidance and the viewer's own. One read of
// `agentGuidance.read` per page open (a one-off query, never a subscription); each save is one retry-safe mutation; nothing
// runs while idle. The server decides who may edit the project text (owner or guidance maintainer) and says so in
// `projectEditable`; the page only reflects it.
import { useCallback, useEffect, useState } from 'react';
import { useConvex } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import { crumbsFor, Head } from '../Place';
import type { PlaceProps } from '../screen-route';
import { AgentGuidanceView } from './AgentGuidanceView';
import type { Guidance } from './guidance-model';

export default function AgentGuidance({ projectId, route, projectName }: PlaceProps) {
  const client = useConvex();
  const [guidance, setGuidance] = useState<Guidance | null>(null);
  const [failed, setFailed] = useState(false);
  const read = useCallback(() => {
    void client
      .query(api.agentGuidance.read, { projectId })
      .then(next => {
        setGuidance(next);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, [client, projectId]);
  useEffect(read, [read]);
  const trail = crumbsFor(route, projectName);
  if (!guidance)
    return (
      <Head
        trail={trail}
        sentence={failed ? 'Agent guidance could not be read just now.' : 'Reading agent guidance…'}
      />
    );
  return (
    <AgentGuidanceView
      guidance={guidance}
      trail={trail}
      save={async ({ scope, text, operationId }) => {
        await client.mutation(api.agentGuidance.set, {
          operationId,
          scope,
          agentGuidance: text,
          ...(scope === 'project' ? { projectId } : {}),
        });
      }}
    />
  );
}
