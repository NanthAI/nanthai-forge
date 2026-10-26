// SPDX-License-Identifier: Apache-2.0
import { useState, type ReactNode } from 'react';
/** A multi-Lane View keeps every input conversation reachable in the same place. */
export function ConversationScope({
  lanes,
  children,
}: {
  lanes: readonly { id: string; name: string }[];
  children: (laneId: string | undefined) => ReactNode;
}) {
  const [selected, select] = useState('');
  const laneId = lanes.find(lane => lane.id === selected)?.id ?? lanes[0]?.id;
  return (
    <div>
      {lanes.length > 1 && (
        <label className="fx-panel-note">
          Lane{' '}
          <select
            className="fx-input"
            aria-label="Conversation Lane"
            value={laneId}
            onChange={event => select(event.target.value)}
          >
            {lanes.map(lane => (
              <option key={lane.id} value={lane.id}>
                {lane.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {children(laneId)}
    </div>
  );
}
