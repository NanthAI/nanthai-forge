// SPDX-License-Identifier: Apache-2.0
import type { InitiativeLinks } from '../cockpit/scale-model';
import { Glyph } from '../ui/Glyph';
import { useState } from 'react';
import { Avatar, Button, Segmented, StatusPill } from '../ui/primitives';
import { age } from '../ui/status';
import {
  boardColumns,
  boardLabels,
  intentColumns,
  intentFlags,
  recentDone,
  type BoardColumn,
} from './board-model';
import type { IntentRow } from './model';
import './board.css';

export function IntentBoard({
  rows,
  initiatives = new Map(),
  now,
  intentHref,
  showDone,
}: {
  initiatives?: InitiativeLinks;
  rows: readonly IntentRow[];
  now: number;
  intentHref: (id: string) => string;
  showDone: () => void;
}) {
  const columns = intentColumns(rows);
  const [selected, setSelected] = useState<BoardColumn>('working');
  const [doneOpen, setDoneOpen] = useState(false);
  return (
    <div className="fx-intent-board-wrap">
      <div className="fx-board-picker">
        <Segmented
          label="Intent column"
          value={selected}
          onChange={value => {
            setSelected(value);
          }}
          options={boardColumns.map(id => ({
            id,
            label: (
              <>
                {boardLabels[id]} <span className="fx-count">{columns[id].length}</span>
              </>
            ),
          }))}
        />
      </div>
      <div className="fx-intent-board">
        {boardColumns.map(column => (
          <BoardColumnView
            key={column}
            column={column}
            rows={columns[column]}
            initiatives={initiatives}
            now={now}
            intentHref={intentHref}
            selected={selected === column}
            doneOpen={doneOpen}
            toggleDone={() => setDoneOpen(value => !value)}
            showDone={showDone}
          />
        ))}
      </div>
    </div>
  );
}
function BoardColumnView({
  column,
  initiatives,
  rows,
  now,
  intentHref,
  selected,
  doneOpen,
  toggleDone,
  showDone,
}: {
  initiatives: InitiativeLinks;
  column: BoardColumn;
  rows: readonly IntentRow[];
  now: number;
  intentHref: (id: string) => string;
  selected: boolean;
  doneOpen: boolean;
  toggleDone: () => void;
  showDone: () => void;
}) {
  const pageSize = column === 'planned' ? 5 : 20;
  const [limit, setLimit] = useState(pageSize);
  const shown = column === 'done' ? recentDone(rows, now) : rows;
  return (
    <section
      className={`fx-board-column${column === 'done' ? ' fx-board-done' : ''}${selected ? ' fx-board-selected' : ''}${column === 'done' && !doneOpen ? ' fx-board-done-collapsed' : ''}`}
      aria-label={`${boardLabels[column]} · ${rows.length}`}
    >
      <header className="fx-board-heading">
        <h2>
          <StatusPill
            tone={
              column === 'planned'
                ? 'plain'
                : column === 'working'
                  ? 'active'
                  : column === 'checking'
                    ? 'running'
                    : 'passed'
            }
          >
            {boardLabels[column]}
          </StatusPill>
        </h2>
        <span className="fx-count">{rows.length}</span>
        {column === 'done' && (
          <button
            type="button"
            className="fx-board-done-toggle"
            aria-expanded={doneOpen}
            onClick={toggleDone}
          >
            {doneOpen ? 'Collapse' : 'Expand'}
          </button>
        )}
      </header>
      {column === 'done' && <p className="fx-board-scope">Past 7 days</p>}
      <div className="fx-board-scroll" tabIndex={0} aria-label={`${boardLabels[column]} Intents`}>
        {shown.length ? (
          <ul>
            {shown.slice(0, limit).map(row => (
              <IntentCard
                key={row.id}
                row={row}
                now={now}
                href={intentHref(row.id)}
                initiative={initiatives.get(row.id)?.title}
              />
            ))}
          </ul>
        ) : (
          <p className="fx-board-empty">
            {column === 'done'
              ? 'Nothing done this week.'
              : `Nothing ${column === 'ready' ? 'ready' : column}.`}
          </p>
        )}
        {shown.length > limit && (
          <Button variant="ghost" size="sm" onClick={() => setLimit(value => value + pageSize)}>
            Show {Math.min(pageSize, shown.length - limit)} more
          </Button>
        )}
      </div>
      {column === 'done' && (
        <button type="button" className="fx-board-show-all" onClick={showDone}>
          Show all {rows.length}
        </button>
      )}
    </section>
  );
}
function IntentCard({
  row,
  now,
  href,
  initiative,
}: {
  row: IntentRow;
  now: number;
  href: string;
  initiative?: string | undefined;
}) {
  const flags = intentFlags(row);
  const accepted = row.lanes.filter(lane => lane.accepted).length;
  const done = row.status === 'completed' || row.status === 'abandoned';
  const landedAt = row.status === 'completed' ? row.landedAt : undefined;
  const agents =
    row.agents ??
    [
      ...new Set(
        row.lanes.flatMap(lane => {
          const name = lane.session?.name ?? lane.startedBy?.name;
          const agent = lane.session ? !lane.session.person : lane.startedBy?.kind === 'agent';
          return agent && name && !/^agent workflow$/i.test(name) ? [name] : [];
        }),
      ),
    ].map(name => ({ name, identity: name }));
  const checks = row.lanes.filter(lane => lane.runStatus && !lane.laterViewId);
  const check = checks.some(lane => lane.runStatus === 'failed')
    ? (['failed', 'Check failed'] as const)
    : checks.some(lane => ['queued', 'preparing', 'running'].includes(lane.runStatus!))
      ? (['running', 'Checking'] as const)
      : checks.some(lane => lane.runStatus === 'passed')
        ? (['passed', 'Check passed'] as const)
        : null;
  return (
    <li>
      <a className="fx-intent-card" href={href}>
        <span className="fx-intent-title" title={row.outcome}>
          {row.outcome}
        </span>
        {initiative && <span className="fx-faint">{initiative}</span>}
        {!row.planned && (!done || row.status === 'abandoned' || landedAt || check) && (
          <span className="fx-board-meta">
            <span>
              {done ? (
                <>
                  {row.status === 'abandoned' ? 'Abandoned' : landedAt ? 'Landed' : ''}
                  {landedAt && (
                    <>
                      {' '}
                      <time dateTime={landedAt} title={new Date(landedAt).toLocaleString()}>
                        {age(landedAt, now) === 'now' ? 'now' : `${age(landedAt, now)} ago`}
                      </time>
                    </>
                  )}
                </>
              ) : (
                <>
                  {row.lanes.length} {row.lanes.length === 1 ? 'Lane' : 'Lanes'}
                  {row.lanes.length > 1 && accepted > 0 && <> · {accepted} landed</>}
                </>
              )}
            </span>
            {check && (
              <span
                className={`fx-board-check fx-tone-${check[0]}`}
                role="img"
                aria-label={check[1]}
                title={check[1]}
              >
                <Glyph name={check[0]} size={12} />
              </span>
            )}
          </span>
        )}
        {row.lanes.length > 1 && (!done || accepted > 0) && (
          <progress
            max={row.lanes.length || 1}
            value={accepted}
            aria-label={`${accepted} of ${row.lanes.length} Lanes landed`}
            title={`${accepted} of ${row.lanes.length} Lanes landed`}
          />
        )}
        {(flags.paused || flags.needsYou || flags.failed) && (
          <span className="fx-board-flags">
            {flags.paused && <StatusPill tone="waiting">Paused</StatusPill>}
            {flags.needsYou && <StatusPill tone="waiting">Needs you</StatusPill>}
            {flags.failed && <StatusPill tone="failed">Check failed</StatusPill>}
          </span>
        )}
        {!row.planned && (agents.length > 0 || (!done && row.lastAt)) && (
          <span className="fx-board-meta fx-board-footer">
            {agents.length > 0 && (
              <span
                className="fx-board-agents"
                aria-label={`Agents: ${agents.map(agent => agent.name).join(', ')}`}
              >
                {agents.slice(0, 4).map(agent => (
                  <Avatar
                    key={agent.identity}
                    name={agent.name}
                    identity={agent.identity}
                    kind="agent"
                    size="sm"
                  />
                ))}
                {agents.length > 4 && <span>+{agents.length - 4}</span>}
              </span>
            )}
            {!done && row.lastAt && (
              <time dateTime={row.lastAt} title={new Date(row.lastAt).toLocaleString()}>
                {age(row.lastAt, now)}
              </time>
            )}
          </span>
        )}
      </a>
    </li>
  );
}
