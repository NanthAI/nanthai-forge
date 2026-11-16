// SPDX-License-Identifier: Apache-2.0
// The dock: a screen's regions in a full-width row on top and two columns below. A region moves by its handle with the
// same model as a list (Enter picks up, arrow keys choose, Enter drops, Escape cancels; Tab reaches the other parts of
// the dock while carrying it), or by the handle's menu: up, down, to the other column, full width, reset the layout.
import { useState, type ReactNode } from 'react';
import {
  Button,
  DropIndicator,
  GridList,
  GridListItem,
  isTextDropItem,
  useDragAndDrop,
  type DropItem,
  type DropTarget,
} from 'react-aria-components';
import { ActionMenu, type MenuAction } from './Menu';
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

export const zoneOf = (layout: DockLayout, id: string) => ZONES.find(z => layout[z].includes(id)) ?? 'a';

const targetIndex = (layout: DockLayout, zone: DockZone, moving: string, target: DropTarget) =>
  dropIndex(layout[zone], moving, target);

export function Dock({ label, regions, layout, onLayout, onReset }: DockProps) {
  const byId = new Map(regions.map(region => [region.id, region]));
  const [message, announce] = useAnnounce();
  const [moving, setMoving] = useState<string | null>(null);
  const place = (id: string, zone: DockZone, index: number) => {
    const next = moveRegion(layout, id, zone, index);
    const at = next[zone].indexOf(id);
    if (zoneOf(layout, id) === zone && layout[zone].indexOf(id) === at) return;
    onLayout(next);
    announce(
      `Moved ${byId.get(id)?.title ?? 'region'} to ${ZONE_WORDS[zone]}, position ${at + 1} of ${next[zone].length}.`,
    );
  };
  const menu = (id: string): MenuAction[] => {
    const zone = zoneOf(layout, id);
    const index = layout[zone].indexOf(id);
    const other: DockZone = zone === 'b' ? 'a' : 'b';
    return [
      { id: 'up', label: 'Up one', disabled: index === 0, onAction: () => place(id, zone, index - 1) },
      {
        id: 'down',
        label: 'Down one',
        disabled: index === layout[zone].length - 1,
        onAction: () => place(id, zone, index + 1),
      },
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
      'separator',
      {
        id: 'reset',
        label: 'Reset layout',
        onAction: () => {
          onReset();
          announce('Layout reset.');
        },
      },
    ];
  };
  return (
    <EnglishOnly>
      <div className="dock" role="group" aria-label={label} data-dock="">
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
          />
        ))}
        <Announcer message={message} />
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
};

function Zone({ zone, layout, byId, place, menu, moving, setMoving }: ZoneProps) {
  const items = layout[zone].map(id => byId.get(id)).filter((region): region is DockRegion => !!region);
  const dropped = async (items: DropItem[], target: DropTarget) => {
    const first = items.find(isTextDropItem);
    if (!first) return;
    const id = await first.getText(TYPE);
    place(id, zone, targetIndex(layout, zone, id, target));
  };
  const { dragAndDropHooks } = useDragAndDrop<DockRegion>({
    getItems: keys =>
      [...keys].map(key => ({ [TYPE]: String(key), 'text/plain': byId.get(String(key))?.title ?? '' })),
    acceptedDragTypes: [TYPE],
    getDropOperation: () => 'move',
    onDragStart: event => setMoving(String([...event.keys][0])),
    onDragEnd: () => setMoving(null),
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
      {region => (
        <GridListItem id={region.id} textValue={region.title} className="ds-region">
          {region.render(
            <>
              <Button
                slot="drag"
                className="grip ds-drag"
                aria-label={`Move ${region.title}`}
                data-focus-key={`drag-${region.id}`}
              >
                <GripIcon />
              </Button>
              <ActionMenu
                label={`Move ${region.title}`}
                className="grip ds-move"
                focusKey={`drag-${region.id}`}
                items={menu(region.id)}
              >
                <GripIcon />
              </ActionMenu>
            </>,
          )}
        </GridListItem>
      )}
    </GridList>
  );
}
