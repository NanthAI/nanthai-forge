import { InlineWorkNav, useWorkHeader } from '../shell/WorkHeader';
// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import type { DecisionRecord } from '../../../src/decision-types';
import { Panel, Segmented, Button } from '../ui/primitives';
import { OwnerDecisionRecord, type DecisionLinks } from './OwnerDecisionRecord';
import {
  decisionGroups,
  decisionDate,
  decisionDay,
  decisionOrder,
  type DecisionFilter,
  type DecisionIntent,
} from './model';
import { age } from '../ui/status';

export function OwnerDecisionsList({
  records,
  intents,
  now,
  initialFilter = 'active',
  ...links
}: DecisionLinks & {
  records: readonly DecisionRecord[];
  intents: readonly DecisionIntent[];
  now: number;
  initialFilter?: DecisionFilter;
}) {
  const header = useWorkHeader();
  const [filter, setFilter] = useState<DecisionFilter>(initialFilter);
  const [target, setTarget] = useState('all');
  const [expanded, setExpanded] = useState<string[]>([]);
  const superseded = records.filter(record => records.some(next => next.supersedes === record.id)).length;
  const latest = decisionOrder(records)[0];
  const groups = decisionGroups(records, filter, target);
  // TODO(B1.5b): add the hosted write path, composer and recording/handoff actions.
  return (
    <div className="fx-owner-decisions">
      <div className="fx-lane-head">
        <div className="fx-lane-head-main">
          <h1>Owner decisions</h1>
          {latest && (
            <p className="fx-situation">
              <b>{records.length - superseded} active</b>, {superseded} superseded · latest{' '}
              {age(latest.decidedAt, now)}: {latest.what} ·{' '}
              {records.filter(record => record.target.kind === 'intent').length} for an Intent
            </p>
          )}
        </div>
      </div>
      <div className="fx-filters">
        {header && <InlineWorkNav header={header} />}
        <label className="fx-odec-target">
          Target:{' '}
          <select
            className="fx-input"
            aria-label="Decision target"
            value={target}
            onChange={event => setTarget(event.target.value)}
          >
            <option value="all">Project + Intents</option>
            <option value="project">Project</option>
            {intents.map(intent => (
              <option key={intent.id} value={intent.id}>
                {intent.outcome}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="fx-work-grid">
        <div>
          <Panel
            title="Owner decisions"
            count={groups.reduce((sum, group) => sum + group.records.length, 0)}
            actions={
              <Segmented
                label="Owner decision status"
                value={filter}
                onChange={setFilter}
                options={[
                  { id: 'active', label: 'Active' },
                  { id: 'superseded', label: 'Superseded' },
                  { id: 'all', label: 'All' },
                ]}
              />
            }
          >
            {!groups.length && (
              <p className="fx-panel-note">
                {records.length ? 'No owner decisions match these filters.' : 'No owner decisions yet.'}
              </p>
            )}
            {groups.map(group => (
              <div key={group.day}>
                <div className="fx-odec-day">{decisionDay(group.day, now)}</div>
                {(expanded.includes(group.day) ? group.records : group.records.slice(0, 10)).map(record => (
                  <OwnerDecisionRecord key={record.id} {...links} {...{ record, records, intents, now }} />
                ))}
                {group.records.length > 10 && !expanded.includes(group.day) && (
                  <footer className="fx-panel-f">
                    {group.records.length - 10} more {'from'} {decisionDate(group.day)} ·{' '}
                    <Button variant="ghost" size="sm" onClick={() => setExpanded([...expanded, group.day])}>
                      Show all
                    </Button>
                  </footer>
                )}
              </div>
            ))}
          </Panel>
        </div>
      </div>
    </div>
  );
}
