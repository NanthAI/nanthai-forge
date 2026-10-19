// SPDX-License-Identifier: Apache-2.0
import { intentProgress } from '../../src/work-intent-progress';
import { PagedList } from './cockpit/ScaleList';
import { StatusPill } from './ui/primitives';

export function PlanningIntents({
  ids,
  intents,
  lanes,
  href,
}: {
  ids: readonly string[];
  intents: readonly { id: string; outcome: string; status: string }[];
  lanes: readonly { intentId: string }[];
  href: (id: string) => string;
}) {
  const rows = ids.flatMap(id => {
    const intent = intents.find(value => value.id === id);
    if (!intent) return [];
    const label = intentProgress(intent.status, lanes.filter(lane => lane.intentId === id).length);
    return [{ ...intent, label }];
  });
  return (
    <PagedList
      rows={rows}
      size={5}
      label="linked Intents"
      className="planning-linked-intents"
      render={intent => (
        <li key={intent.id}>
          <a href={href(intent.id)}>{intent.outcome}</a>
          <StatusPill
            tone={
              intent.label === 'Planned' || intent.label === 'Abandoned'
                ? 'plain'
                : intent.label === 'Working'
                  ? 'active'
                  : 'passed'
            }
          >
            {intent.label}
          </StatusPill>
        </li>
      )}
    />
  );
}
