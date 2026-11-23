// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The dock: a screen's regions in a full-width row on top and two columns below. A region moves by its handle with the
// same model as a list (Enter picks up, arrow keys choose, Enter drops, Escape cancels; Tab reaches the other parts of
// the dock while carrying it), or by the handle's menu: up, down, to the other column, full width, reset the layout.
// An empty zone is not drawn at rest (the other column takes the full width); it comes back as a drop target, saying
// "Drop a region here", only while a region is carried on a Dock that supports cross-column moves.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  DropIndicator,
  GridList,
  GridListItem,
  isTextDropItem,
  useDragAndDrop,
  type DropItem,
  type DropTarget,
  type GridListItemProps,
} from 'react-aria-components';
import { DockMount, type DockHosts } from '../dock-regions';
import { ActionMenu, type MenuAction } from './Menu';
import { DockToast, useDockGripFocus, type DockMove } from './DockToast';
import { Announcer, useAnnounce } from './announce';
import { dropIndex } from './ReorderList';
import { EnglishOnly, GripIcon, ordinal } from './shared';

export type DockZone = 'top' | 'a' | 'b';
export type DockLayout = Record<DockZone, readonly string[]>;
export type DockRegion = { id: string; title: string; render: (handle: ReactNode) => ReactNode };

const TYPE = 'application/x-forge-region';
const ZONES: readonly DockZone[] = ['top', 'a', 'b'];
const ZONE_WORDS: Record<DockZone, string> = {
  top: 'the full-width row',
  a: 'the left column',
  b: 'the right column',
};
const ZONE_LABEL: Record<DockZone, string> = { top: 'Full-width row', a: 'Left column', b: 'Right column' };

export type DockProps = {
  label: string;
  regions: readonly DockRegion[];
  layout: DockLayout;
  onLayout: (next: DockLayout) => void;
  onReset: () => void;
  /** A flat layout uses in-column moves only, including first and last. */
  singleColumn?: boolean;
};

/** Moves `id` into `zone` at `index` (index counted without the region itself), keeping every region exactly once. */
export function moveRegion(layout: DockLayout, id: string, zone: DockZone, index: number): DockLayout {
  const next = Object.fromEntries(ZONES.map(z => [z, layout[z].filter(r => r !== id)])) as Record<
    DockZone,
    string[]
  >;
  next[zone].splice(Math.max(0, Math.min(next[zone].length, index)), 0, id);
  return next;
}

/** The zones not drawn at rest: the empty ones, while no region is carried (a carried region needs every zone). */
export const shutZones = (layout: DockLayout, carrying = false) =>
  carrying ? undefined : ZONES.filter(zone => !layout[zone].length).join(' ') || undefined;

export const zoneOf = (layout: DockLayout, id: string) => ZONES.find(z => layout[z].includes(id)) ?? 'a';

const targetIndex = (layout: DockLayout, zone: DockZone, moving: string, target: DropTarget) =>
  dropIndex(layout[zone], moving, target);

export function Dock({
  label,
  regions,
  layout,
  onLayout,
  onReset,
  singleColumn = false,
  initialMenu,
  hosts,
  onAttach,
}: DockProps & { initialMenu?: string; hosts: DockHosts; onAttach: (host: HTMLElement) => void }) {
  const byId = new Map(regions.map(region => [region.id, region]));
  const [message, announce] = useAnnounce();
  const root = useRef<HTMLDivElement>(null);
  const returnFocus = useDockGripFocus(root);
  const nativeDrag = useRef(false);
  const [carry, setCarry] = useState<{ id: string; native: boolean } | null>(null);
  const moving = carry?.id ?? null;
  const setMoving = (id: string | null) => setCarry(id === null ? null : { id, native: nativeDrag.current });
  const [openingMenu, setOpeningMenu] = useState(initialMenu);
  const [lastMove, setLastMove] = useState<DockMove | null>(null);
  const expire = useCallback(() => setLastMove(null), []);
  const undo = lastMove?.next === layout ? lastMove : null;
  const dismissToast = (id: string) => {
    expire();
    returnFocus(id);
  };
  const reset = (id: string) => {
    onReset();
    setOpeningMenu(undefined);
    dismissToast(id);
    announce('Layout reset.');
  };
  const place = (id: string, zone: DockZone, index: number) => {
    const from = zoneOf(layout, id);
    if (singleColumn && from !== zone) return;
    const next = moveRegion(layout, id, zone, index);
    const at = next[zone].indexOf(id);
    if (from === zone && layout[zone].indexOf(id) === at) return;
    const title = byId.get(id)?.title;
    if (!title) return;
    onLayout(next);
    setMoving(null);
    setOpeningMenu(undefined);
    setLastMove({ previous: layout, next, title, id });
    announce(`Moved ${title} to ${ZONE_WORDS[zone]}, position ${at + 1} of ${next[zone].length}.`);
  };
  const menu = (id: string): MenuAction[] => {
    const zone = zoneOf(layout, id);
    const index = layout[zone].indexOf(id);
    const other: DockZone = zone === 'b' ? 'a' : 'b';
    const last = layout[zone].length - 1;
    const jump: MenuAction[] = singleColumn
      ? [
          { id: 'top', label: 'Move to top', disabled: index === 0, onAction: () => place(id, zone, 0) },
          {
            id: 'bottom',
            label: 'Move to bottom',
            disabled: index === last,
            onAction: () => place(id, zone, last),
          },
        ]
      : [
          {
            id: 'other',
            label:
              zone === 'top' ? 'Into the left column' : `Into the ${other === 'a' ? 'left' : 'right'} column`,
            onAction: () => place(id, zone === 'top' ? 'a' : other, 0),
          },
          {
            id: 'wide',
            label: 'Full width',
            disabled: zone === 'top',
            onAction: () => place(id, 'top', layout.top.length),
          },
        ];
    return [
      { id: 'up', label: 'Up one', disabled: index === 0, onAction: () => place(id, zone, index - 1) },
      { id: 'down', label: 'Down one', disabled: index === last, onAction: () => place(id, zone, index + 1) },
      ...jump,
      'separator',
      { id: 'reset', label: 'Reset layout', onAction: () => reset(id) },
    ];
  };
  return (
    <EnglishOnly>
      <div
        className="dock"
        ref={root}
        role="group"
        aria-label={label}
        data-dock=""
        data-carrying={carry ? '' : undefined}
        data-native-drag={carry?.native && !singleColumn ? '' : undefined}
        data-shut={shutZones(layout, !!carry && !carry.native && !singleColumn)}
        onDragStartCapture={event => {
          const target = event.target;
          nativeDrag.current =
            target instanceof HTMLElement &&
            target.matches('.ds-drag') &&
            target.closest('.ds-region')?.parentElement?.parentElement === root.current;
        }}
        onDragEndCapture={() => {
          nativeDrag.current = false;
        }}
      >
        {ZONES.map(zone => (
          <Zone
            key={zone}
            zone={zone}
            layout={layout}
            byId={byId}
            place={place}
            menu={menu}
            moving={moving}
            setMoving={setMoving}
            initialMenu={openingMenu}
            hosts={hosts}
            onAttach={onAttach}
          />
        ))}
        <Announcer message={message} />
        {undo ? (
          <DockToast
            move={undo}
            onExpire={expire}
            onUndo={() => {
              onLayout(undo.previous);
              dismissToast(undo.id);
              announce(`Move of ${undo.title} undone.`);
            }}
            onReset={() => reset(undo.id)}
          />
        ) : null}
      </div>
    </EnglishOnly>
  );
}

type ZoneProps = {
  zone: DockZone;
  layout: DockLayout;
  byId: Map<string, DockRegion>;
  place: (id: string, zone: DockZone, index: number) => void;
  menu: (id: string) => MenuAction[];
  moving: string | null;
  setMoving: (id: string | null) => void;
  initialMenu?: string;
  hosts: DockHosts;
  onAttach: (host: HTMLElement) => void;
};

// React Aria listens on the row, but native drag starts on the grip. Links and selectable text in a region stay ordinary.
const renderRegion: GridListItemProps['render'] = ({ onDragStart, ...props }) => (
  <div
    {...props}
    draggable={false}
    onDragStart={event => {
      if (event.target instanceof HTMLElement && event.target.matches('.ds-drag')) onDragStart?.(event);
    }}
  />
);

function Zone({
  zone,
  layout,
  byId,
  place,
  menu,
  moving,
  setMoving,
  initialMenu,
  hosts,
  onAttach,
}: ZoneProps) {
  const items = layout[zone].map(id => byId.get(id)).filter((region): region is DockRegion => !!region);
  const dropped = async (items: DropItem[], target: DropTarget) => {
    const first = items.find(isTextDropItem);
    if (!first) return;
    const id = await first.getText(TYPE);
    place(id, zone, targetIndex(layout, zone, id, target));
  };
  const reveal = useRef(0);
  useEffect(() => () => cancelAnimationFrame(reveal.current), []);
  const { dragAndDropHooks } = useDragAndDrop<DockRegion>({
    getItems: keys =>
      [...keys].map(key => ({ [TYPE]: String(key), 'text/plain': byId.get(String(key))?.title ?? '' })),
    acceptedDragTypes: [TYPE],
    getDropOperation: () => 'move',
    onDragStart: event => {
      // WebKit needs the source's layout to stay still until native dragstart finishes.
      // Revealing an empty zone here used to end the drag before the first dragover.
      const id = String([...event.keys][0]);
      reveal.current = requestAnimationFrame(() => setMoving(id));
    },
    onDragEnd: () => {
      cancelAnimationFrame(reveal.current);
      setMoving(null);
    },
    onReorder: event => {
      const id = String([...event.keys][0]);
      place(id, zone, targetIndex(layout, zone, id, event.target));
    },
    onInsert: event => void dropped(event.items, event.target),
    onRootDrop: event => void dropped(event.items, { type: 'root' }),
    renderDropIndicator: target => (
      <DropIndicator target={target} className="dropline">
        {({ isDropTarget }) =>
          isDropTarget && moving ? (
            <span>
              {byId.get(moving)?.title}, {ZONE_LABEL[zone].toLowerCase()},{' '}
              {ordinal(targetIndex(layout, zone, moving, target) + 1)}
            </span>
          ) : null
        }
      </DropIndicator>
    ),
  });
  return (
    <GridList
      aria-label={ZONE_LABEL[zone]}
      className="zone"
      data-zone={zone}
      items={items}
      // A region's handle menu depends on the whole layout (up, down, the other column), so the layout invalidates the
      // library's cached rows, as do new region objects from the screen.
      dependencies={[layout, items]}
      dragAndDropHooks={dragAndDropHooks}
      keyboardNavigationBehavior="tab"
      renderEmptyState={() => <div className="zone-empty">Drop a region here</div>}
    >
      {region => {
        const host = hosts.get(region.id)!;
        return (
          <GridListItem id={region.id} textValue={region.title} className="ds-region" render={renderRegion}>
            <DockMount host={host.body} onAttach={onAttach} />
            {createPortal(
              <DockGrip
                title={region.title}
                id={region.id}
                items={menu(region.id)}
                open={initialMenu === region.id}
              />,
              host.grip,
            )}
          </GridListItem>
        );
      }}
    </GridList>
  );
}

function DockGrip({
  title,
  id,
  items,
  open,
}: {
  title: string;
  id: string;
  items: MenuAction[];
  open: boolean;
}) {
  const menuOnly = open && matchMedia('(pointer: coarse)').matches;
  return (
    <>
      <ActionMenu
        label={`Move ${title}`}
        className="grip ds-drag"
        focusKey={`drag-${id}`}
        items={items}
        dragHandle
        defaultOpen={open && !menuOnly}
        autoFocus={open && !menuOnly}
      >
        <GripIcon />
      </ActionMenu>
      <ActionMenu
        label={`Move ${title}`}
        className="grip ds-move"
        focusKey={`drag-${id}`}
        items={items}
        defaultOpen={menuOnly}
        autoFocus={menuOnly}
      >
        <GripIcon />
      </ActionMenu>
    </>
  );
}
