// SPDX-License-Identifier: Apache-2.0
// The backlog's Initiative groups (Item 4df3ee17; decision afcb5bc3; f49e3a5c). Each group folds to its header and
// stays as this viewer left it (fold.ts, this browser only). With every group folded the list is the Initiatives
// overview: one row each, dragged or moved by keyboard into hand order. An open group's header keeps a Move key for
// the keyboard and phones. The header's name opens the Initiative page. A move is one put-planning-item `order`, as
// for an Item.
import { Count, Menu, ReorderList } from '../../ds';
import type { PlanRow } from '../../../../src/planning-model';
import { A } from '../frames';
import type { PlaceProps } from '../screens';
import { isShut, NO_INITIATIVE, type Folds } from './fold';
import { groupBreakdown, type PlanGroup, type PlanView } from './model';
import { filtered, sortRows, type PlanQuery } from './query';
import { BreakdownWords, COLS, Line, Roll } from './rows';
import { Tick, type Ticker } from './Tick';
import type { Workers } from './workers';

type At = (patch: Partial<PlaceProps['route']>) => string;
const groupId = (group: PlanGroup) => group.initiative?.id ?? NO_INITIATIVE;
/** The handle's dots, drawn here so the plan chunk never loads the behaviour layer for an icon. */
const Dots = () => (
  <svg width="10" height="16" viewBox="0 0 10 16" aria-hidden="true" fill="currentColor">
    {[3, 8, 13].flatMap(y => [
      <circle key={`a${y}`} cx="2.5" cy={y} r="1.4" />,
      <circle key={`b${y}`} cx="7.5" cy={y} r="1.4" />,
    ])}
  </svg>
);

export function Groups({
  view,
  query,
  byHand,
  at,
  ticker,
  folds,
  workers,
  onToggle,
  onMove,
  onMoveInitiative,
}: {
  view: PlanView;
  query: PlanQuery;
  byHand: boolean;
  at: At;
  ticker: Ticker | undefined;
  folds: Folds;
  /** Who works on each unowned Item now (workers.ts). */
  workers?: Workers | undefined;
  onToggle: (id: string) => void;
  onMove: (group: PlanGroup, id: string, toIndex: number) => void;
  /** Absent when the order cannot change here (not the owner, sorted or filtered). */
  onMoveInitiative?: ((id: string, toIndex: number) => void) | undefined;
}) {
  const shown = view.groups.filter(group => !filtered(query) || group.lines.length);
  const initiatives = shown.flatMap(group => (group.initiative ? [group.initiative] : []));
  if (shown.length && shown.every(group => isShut(folds, groupId(group))))
    return <Overview groups={shown} at={at} onToggle={onToggle} onMoveInitiative={onMoveInitiative} />;
  return (
    <>
      {shown.map(group => (
        <Group
          key={groupId(group)}
          group={group}
          view={view}
          query={query}
          byHand={byHand}
          at={at}
          ticker={ticker}
          workers={workers}
          shut={isShut(folds, groupId(group))}
          onToggle={() => onToggle(groupId(group))}
          onMove={(id, toIndex) => onMove(group, id, toIndex)}
          move={
            group.initiative && onMoveInitiative
              ? moveItems(initiatives, group.initiative, onMoveInitiative)
              : undefined
          }
          aligned={Boolean(onMoveInitiative)}
        />
      ))}
    </>
  );
}

/** The Move key's choices for one Initiative among those shown. */
function moveItems(
  initiatives: readonly PlanRow[],
  initiative: PlanRow,
  onMoveInitiative: (id: string, toIndex: number) => void,
) {
  const index = initiatives.findIndex(row => row.id === initiative.id);
  const last = initiatives.length - 1;
  const to = (target: number) => () => onMoveInitiative(initiative.id, target);
  return [
    { id: 'top', label: 'To the top', disabled: index <= 0, onAction: to(0) },
    { id: 'up', label: 'Up one', disabled: index <= 0, onAction: to(index - 1) },
    { id: 'down', label: 'Down one', disabled: index >= last, onAction: to(index + 1) },
    { id: 'bottom', label: 'To the bottom', disabled: index >= last, onAction: to(last) },
  ];
}

/** A group's name, its count of every Item and its roll-up with the breakdown (b7a0dff1): the header open or folded. */
function Head({
  group,
  at,
  shut,
  onToggle,
  controls,
}: {
  group: PlanGroup;
  at: At;
  shut: boolean;
  onToggle: () => void;
  /** The id of the Items this header folds, when they are drawn below it. */
  controls?: string;
}) {
  const name = group.initiative?.title ?? 'No Initiative';
  const breakdown = groupBreakdown(group);
  return (
    <>
      {group.initiative ? (
        <A className="plan-gn" href={at({ rest: group.initiative.id })} dir="auto" title={name}>
          {name}
        </A>
      ) : (
        <span className="plan-gn">{name}</span>
      )}
      <Count n={breakdown.total} />
      {group.initiative ? (
        <span className="plan-prog">
          <Roll breakdown={breakdown} />
          <span className="plan-pl">
            <BreakdownWords breakdown={breakdown} />
            {group.initiative.hidden ? ', hidden from the public plan' : ''}
          </span>
        </span>
      ) : (
        <span className="plan-pl t3">not in an Initiative yet</span>
      )}
      <button
        type="button"
        className="tw"
        aria-expanded={!shut}
        aria-controls={controls}
        aria-label={`Items of ${name}`}
        onClick={onToggle}
      />
    </>
  );
}

function Overview({
  groups,
  at,
  onToggle,
  onMoveInitiative,
}: {
  groups: readonly PlanGroup[];
  at: At;
  onToggle: (id: string) => void;
  onMoveInitiative?: ((id: string, toIndex: number) => void) | undefined;
}) {
  const movable = groups.filter(group => group.initiative);
  const loose = groups.find(group => !group.initiative);
  const items = movable.map(group => ({ id: groupId(group), label: group.initiative!.title, group }));
  // One cell per row holding the same header as an open group, so it wraps the same way on a phone.
  const cols = 'minmax(0, 1fr)';
  return (
    <div className="plan-over">
      {items.length ? (
        <ReorderList
          label="Initiatives, in order"
          items={items}
          onMove={(id, toIndex) => onMoveInitiative?.(id, toIndex)}
          disabled={!onMoveInitiative}
          cols={cols}
        >
          {({ group }) => (
            <div className="band plan-gh">
              <Head group={group} at={at} shut onToggle={() => onToggle(groupId(group))} />
            </div>
          )}
        </ReorderList>
      ) : null}
      {loose ? (
        <div
          className="row ds-row"
          style={{ gridTemplateColumns: `${onMoveInitiative ? 'auto ' : ''}${cols}` }}
        >
          {onMoveInitiative ? <span className="plan-gsp" aria-hidden="true" /> : null}
          <div className="band plan-gh">
            <Head group={loose} at={at} shut onToggle={() => onToggle(NO_INITIATIVE)} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Group({
  group,
  view,
  query,
  byHand,
  at,
  ticker,
  workers,
  shut,
  onToggle,
  onMove,
  move,
  aligned,
}: {
  group: PlanGroup;
  view: PlanView;
  query: PlanQuery;
  byHand: boolean;
  at: At;
  ticker: Ticker | undefined;
  workers?: Workers | undefined;
  shut: boolean;
  onToggle: () => void;
  onMove: (id: string, toIndex: number) => void;
  move?: { id: string; label: string; disabled: boolean; onAction: () => void }[] | undefined;
  /** Other headers carry a Move key: keep this name in line with theirs. */
  aligned: boolean;
}) {
  const name = group.initiative?.title ?? 'No Initiative';
  const tree = query.layout === 'tree';
  const lines = byHand || query.sort === 'hand' ? group.lines : sortRows(group.lines, query.sort);
  const items = shut ? [] : lines.map(line => ({ id: line.row.id, label: line.row.title, line }));
  const body = `plan-g-${groupId(group)}`;
  return (
    <div className={`grp plan-grp${shut ? ' shut' : ''}`} data-fold="">
      <div className="band plan-gh">
        {move ? (
          <Menu label={`Move ${name}`} className="grip" items={move} focusKey={`move-${groupId(group)}`}>
            <Dots />
          </Menu>
        ) : aligned ? (
          <span className="plan-gsp" aria-hidden="true" />
        ) : null}
        <Head group={group} at={at} shut={shut} onToggle={onToggle} controls={body} />
      </div>
      <div id={body}>
        {items.length ? (
          <ReorderList
            label={`${name}, open Items in order`}
            items={items}
            onMove={onMove}
            disabled={!view.canEdit || !byHand}
            cols={`${ticker ? '28px ' : ''}${COLS}`}
          >
            {({ line }) => (
              <>
                {ticker ? <Tick row={line.row} ticker={ticker} /> : null}
                <Line
                  line={line}
                  href={at({ rest: line.row.id })}
                  ranked={query.sort === 'hand'}
                  flat={!tree}
                  workers={workers}
                />
              </>
            )}
          </ReorderList>
        ) : shut || group.live ? null : (
          <div className="quietline">No open Items.</div>
        )}
      </div>
    </div>
  );
}
