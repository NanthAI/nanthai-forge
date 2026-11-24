// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { PlanRow } from '../../../../src/planning-model';
import { ActionMenu, type MenuAction } from '../../ds/behaviour/Menu';
import { Announcer, useAnnounce } from '../../ds/behaviour/announce';
import { GripIcon } from '../../ds/behaviour/shared';
import { ItemPicker, type SearchOpenItems } from './ItemPicker';
import { NO_INITIATIVE } from './fold';
import type { PlanGroup, PlanView } from './model';
import {
  keyboardDropPlaces,
  planDropTargets,
  type DropChoice,
  type DropMove,
  type DropPlace,
} from './plan-drop';
import { rankAfterParent } from './hierarchy';

export type MoveItem = (row: PlanRow, move: DropMove) => void;
export type PlanDrag = {
  grip: (row: PlanRow) => { handle: ReactNode; hint: ReactNode; onto: boolean };
  band: (group: PlanGroup) => ReactNode;
};
const prefix = 'plan-move-';
const kind = 'application/x-forge-plan-item';
const idFor = (place: DropPlace) =>
  place.position === 'group' ? (place.initiativeId ?? NO_INITIATIVE) : place.id;
const keyFor = (place: DropPlace) => `${place.position}:${idFor(place)}`;
const placeAt = (event: DragEvent): DropPlace | undefined => {
  const target =
    event.target instanceof Element
      ? event.target.closest<HTMLElement>('[data-reorder-id], [data-plan-drop-group]')
      : null;
  if (!target || !event.currentTarget.contains(target)) return;
  const group = target.dataset.planDropGroup;
  if (group !== undefined) return { position: 'group', initiativeId: group === NO_INITIATIVE ? null : group };
  const id = target.dataset.reorderId;
  if (!id) return;
  const rect = target.getBoundingClientRect();
  const fraction = (event.clientY - rect.top) / rect.height;
  return { id, position: fraction < 0.25 ? 'before' : fraction >= 0.75 ? 'after' : 'on' };
};
const gripId = (target: EventTarget) =>
  target instanceof Element
    ? target
        .closest<HTMLButtonElement>('button[data-focus-key^="plan-move-"]')
        ?.dataset.focusKey?.slice(prefix.length)
    : undefined;

function Hint({ place, choice }: { place: DropPlace; choice: DropChoice }) {
  const refused = 'refused' in choice;
  return (
    <div
      aria-hidden="true"
      className={`plan-drop-hint${refused || place.position === 'on' ? '' : ' dropline'}`}
      data-position={place.position}
      data-refused={refused || undefined}
      data-depth={(!refused && choice.depth) || undefined}
    >
      <span>{choice.label}</span>
    </div>
  );
}

/** The drag handle shares the Dock/Plan menu and grid. Its three row zones and keyboard walk share the same
 * destination model, so the announced action is exactly the one the current target would write. */
export function PlanDragging({
  view,
  folded,
  search,
  move,
  children,
}: {
  view: PlanView;
  folded: (group: PlanGroup) => boolean;
  search?: SearchOpenItems | undefined;
  move: MoveItem;
  children: (drag: PlanDrag) => ReactNode;
}) {
  const [carry, setCarry] = useState<{ row: PlanRow; keyboard: boolean }>();
  const [hover, setHover] = useState<DropPlace>();
  const [picker, setPicker] = useState<PlanRow>();
  const [message, announce] = useAnnounce();
  const current = useRef<typeof carry>(undefined);
  const resolve = useMemo(() => planDropTargets(view), [view]);
  const usingKeys = carry?.keyboard;
  const walk = useMemo(() => {
    const places = usingKeys ? keyboardDropPlaces(view, folded) : [];
    return { places, index: new Map(places.map((place, index) => [keyFor(place), index])) };
  }, [usingKeys, view, folded]);
  const siblingsById = useMemo(() => {
    const result = new Map<string, { siblings: readonly PlanRow[]; index: number }>();
    const record = (siblings: readonly PlanRow[]) =>
      siblings.forEach((row, index) => result.set(row.id, { siblings, index }));
    for (const group of view.groups) record(group.lines.flatMap(({ row }) => (row.parentId ? [] : [row])));
    for (const siblings of view.children.values()) record(siblings);
    return result;
  }, [view]);
  const select = (place?: DropPlace) =>
    setHover(was => (was && place && keyFor(was) === keyFor(place) ? was : place));
  const clear = () => {
    current.current = undefined;
    setCarry(undefined);
    select();
  };
  const pick = (row: PlanRow, keyboard: boolean) => {
    const next = { row, keyboard };
    current.current = next;
    setCarry(next);
    select();
    if (keyboard)
      announce(
        `Picked up ${row.title}. Use the arrow keys to choose a place, Enter to drop, or Escape to cancel.`,
      );
  };
  const apply = (row: PlanRow, place: DropPlace) => {
    const choice = resolve(row, place);
    if ('refused' in choice) {
      announce(choice.label);
      return false;
    }
    move(row, choice);
    return true;
  };
  const menuFor = (row: PlanRow): MenuAction[] => {
    const entry = siblingsById.get(row.id);
    const siblings = entry?.siblings ?? [];
    const at = entry?.index ?? -1;
    const reorder = (target: PlanRow | undefined, position: 'before' | 'after') => () => {
      if (target) apply(row, { id: target.id, position });
    };
    const parent = (row.parentId && view.byId.get(row.parentId)) || null;
    return [
      { id: 'top', label: 'To the top', disabled: at <= 0, onAction: reorder(siblings[0], 'before') },
      { id: 'up', label: 'Up one', disabled: at <= 0, onAction: reorder(siblings[at - 1], 'before') },
      {
        id: 'down',
        label: 'Down one',
        disabled: at < 0 || at >= siblings.length - 1,
        onAction: reorder(siblings[at + 1], 'after'),
      },
      {
        id: 'bottom',
        label: 'To the bottom',
        disabled: at < 0 || at >= siblings.length - 1,
        onAction: reorder(siblings.at(-1), 'after'),
      },
      'separator',
      { id: 'under', label: 'Put under…', onAction: () => setPicker(row) },
      ...(row.parentId
        ? [
            {
              id: 'out',
              label: parent
                ? `Out of ${view.numbers.get(parent.id) ?? ''} · ${parent.title}`
                : 'Out of its parent',
              onAction: () =>
                move(row, {
                  label: 'Top level',
                  parent: null,
                  depth: 0,
                  initiativeId: row.initiativeId ?? null,
                  order: rankAfterParent(view, row),
                }),
            },
          ]
        : []),
    ];
  };
  const chosen = carry && hover ? resolve(carry.row, hover) : undefined;
  const decorate = (id: string, group: boolean) =>
    hover && chosen && (hover.position === 'group') === group && idFor(hover) === id ? (
      <Hint place={hover} choice={chosen} />
    ) : null;
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    const id = gripId(event.target);
    const source = current.current;
    if (source?.keyboard && (id !== source.row.id || (event.altKey && event.key === 'ArrowDown'))) clear();
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    if (!source && event.key === 'Enter' && id) {
      const row = view.byId.get(id);
      if (!row) return;
      event.preventDefault();
      event.stopPropagation();
      pick(row, true);
      return;
    }
    if (!source?.keyboard || id !== source.row.id) return;
    if (event.key === 'Tab') return clear();
    const direction = ['ArrowDown', 'ArrowRight'].includes(event.key)
      ? 1
      : ['ArrowUp', 'ArrowLeft'].includes(event.key)
        ? -1
        : 0;
    if (!direction && event.key !== 'Enter' && event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      clear();
      announce('Move cancelled.');
    } else if (event.key === 'Enter') {
      if (hover && apply(source.row, hover)) clear();
    } else {
      const index = walk.index.get(hover ? keyFor(hover) : `on:${source.row.id}`) ?? -1;
      const next = walk.places[Math.min(walk.places.length - 1, Math.max(0, index + direction))];
      if (!next) return;
      select(next);
      announce(resolve(source.row, next).label);
      const attr = next.position === 'group' ? 'data-plan-drop-group' : 'data-reorder-id';
      event.currentTarget
        .querySelector(`[${attr}="${CSS.escape(idFor(next))}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    }
  };
  return (
    <div
      data-plan-drag=""
      onKeyDownCapture={keyboard}
      onDragStartCapture={event => {
        const id = gripId(event.target);
        const row = id && view.byId.get(id);
        if (!row) return;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData(kind, row.id);
        const frame = (event.target as HTMLElement).closest<HTMLElement>('[data-reorder-id]');
        if (frame) event.dataTransfer.setDragImage(frame, 12, Math.round(frame.offsetHeight / 2));
        pick(row, false);
      }}
      onDragOverCapture={event => {
        const source = current.current;
        if (!source || source.keyboard || !event.dataTransfer.types.includes(kind)) return;
        const target = placeAt(event);
        select(target);
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'refused' in resolve(source.row, target) ? 'none' : 'move';
      }}
      onDragLeave={event => {
        if (
          !current.current?.keyboard &&
          !(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))
        )
          select();
      }}
      onDropCapture={event => {
        const source = current.current;
        if (!source || source.keyboard || event.dataTransfer.getData(kind) !== source.row.id) return;
        event.preventDefault();
        event.stopPropagation();
        const target = placeAt(event);
        if (target) apply(source.row, target);
        clear();
      }}
      onDragEnd={clear}
    >
      {children({
        grip: row => ({
          handle: (
            <>
              <ActionMenu
                label={`Move ${row.title}`}
                items={menuFor(row)}
                className="grip ds-drag"
                dragHandle="native"
                focusKey={prefix + row.id}
              >
                <GripIcon />
              </ActionMenu>
              <ActionMenu label={`Move ${row.title}`} items={menuFor(row)} className="grip ds-move">
                <GripIcon />
              </ActionMenu>
            </>
          ),
          hint: decorate(row.id, false),
          onto: hover?.position === 'on' && hover.id === row.id && Boolean(chosen && !('refused' in chosen)),
        }),
        band: group => decorate(group.initiative?.id ?? NO_INITIATIVE, true),
      })}
      <Announcer message={message} />
      {picker ? (
        <ItemPicker
          label={`Put ${picker.title} under…`}
          view={view}
          search={search}
          refusal={target => {
            const choice = resolve(picker, { id: target.id, position: 'on' });
            return 'refused' in choice ? choice.label : undefined;
          }}
          detail={target =>
            (picker.initiativeId ?? null) !== (target.initiativeId ?? null)
              ? 'also moves this Item to this Initiative'
              : undefined
          }
          choose={target => {
            if (apply(picker, { id: target.id, position: 'on' })) setPicker(undefined);
          }}
          cancel={() => setPicker(undefined)}
        />
      ) : null}
    </div>
  );
}
