// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import type { Id } from '../../convex/_generated/dataModel';
import type { WorkData, HostedChannelMove } from '../../src/work-types';
import { hostedHref } from './cockpit/HostedNow';
/** All decisions live on the Candidate's hosted landing surface. */
export default function HostedChannels({
  data,
  channels,
  sourceLabels = {},
}: {
  projectId: Id<'hostedProjects'>;
  archiveSha256: string;
  data: Pick<WorkData, 'revision' | 'channelMoves' | 'hostedChannelMoves'> &
    Partial<Pick<WorkData, 'views' | 'runs'>>;
  channels: HostedChannelMove[];
  sourceLabels?: Record<string, string>;
}) {
  const [selected, setSelected] = useState('');
  const candidates = data.views ?? [];
  return (
    <section className="accepted-versions" aria-label="Canonical hosted Channels">
      <h3>Accepted versions</h3>
      <ul className="accepted-channel-list">
        {channels.map(move => (
          <li key={move.id}>
            <strong>{move.channel}</strong>
            <a href={hostedHref({ projectTab: 'intent', reviewView: move.viewId })}>
              {sourceLabels[move.viewId] ?? 'Open accepted Candidate'}
            </a>
          </li>
        ))}
      </ul>
      <label>
        Candidate
        <select value={selected} onChange={event => setSelected(event.target.value)}>
          <option value="">Choose a Candidate</option>
          {candidates.map(view => (
            <option key={view.id} value={view.id}>
              {sourceLabels[view.id] ?? 'Candidate'} · {new Date(view.at).toLocaleString()}
            </option>
          ))}
        </select>
      </label>
      {selected && (
        <a className="fx-btn" href={hostedHref({ projectTab: 'intent', reviewView: selected })}>
          Review Candidate
        </a>
      )}
    </section>
  );
}
