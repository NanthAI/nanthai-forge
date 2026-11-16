// SPDX-License-Identifier: Apache-2.0
// The one reorder model (DESIGN.md rule 4). Pointer: drag the handle; a line with the place it lands is drawn. Keyboard:
// Enter on the handle picks the row up, arrow keys choose the place, Enter drops, Escape cancels. Phone: the handle is
// a menu (to the top, up, down, to the bottom). Every move is announced with the position the row now has on screen.
import { useRef, useState, type ReactNode } from 'react';
import {
  Button,
  DropIndicator,
  GridList,
  GridListItem,
  useDragAndDrop,
  type DropTarget,
} from 'react-aria-components';
import { ActionMenu } from './Menu';
import { Announcer, useAnnounce } from './announce';
import { EnglishOnly, GripIcon, ordinal } from './shared';

export type ReorderItem = { id: string; label: string };

export type ReorderListProps<T extends ReorderItem> = {
  /** Accessible name of the list, e.g. "Planned Items, in order". */
  label: string;
  items: readonly T[];
  /** Called with the moved row and its new index; the caller stores the order (the list draws what it is given). */
  onMove: (id: string, toIndex: number) => void;
  children: (item: T, index: number) => ReactNode;
  /** Sorted by something other than hand order: the handles go away and dragging is off. */
  disabled?: boolean;
  /** Column template of a row after the handle (see Row in ds/parts.tsx). */
  cols?: string;
};

/** Index the moved row takes when dropped on `target`, counted without the row itself. `order` may hold the row
 * (a move inside one list) or not (a move in from another dock zone). A target next to the row itself is its own
 * place. */
export function dropIndex(order: readonly string[], moving: string, target: DropTarget) {
  if (target.type !== 'item') return order.filter(id => id !== moving).length;
  const at = order.indexOf(String(target.key)) + (target.dropPosition === 'after' ? 1 : 0);
  const from = order.indexOf(moving);
  return from >= 0 && from < at ? at - 1 : at;
}

/** Default columns of an ordered row after its handle: position, the name taking the room, a fact. */
export const LIST_COLS = 'auto auto minmax(0, 1fr) auto';

export function ReorderList<T extends ReorderItem>({
  label,
  items,
  onMove,
  children,
  disabled,
  cols = LIST_COLS,
}: ReorderListProps<T>) {
  const order = items.map(item => item.id);
  const byId = new Map(items.map(item => [item.id, item]));
  const [moving, setMoving] = useState<string | null>(null);
  const [message, announce] = useAnnounce();
  const latest = useRef(order);
  latest.current = order;

  const move = (id: string, toIndex: number) => {
    const total = latest.current.length;
    const index = Math.max(0, Math.min(total - 1, toIndex));
    if (latest.current.indexOf(id) === index) return;
    onMove(id, index);
    announce(`Moved ${byId.get(id)?.label ?? 'row'} to position ${index + 1} of ${total}.`);
  };

  const { dragAndDropHooks } = useDragAndDrop<T>({
    isDisabled: disabled,
    getItems: keys => [...keys].map(key => ({ 'text/plain': byId.get(String(key))?.label ?? String(key) })),
    onDragStart: event => setMoving(String([...event.keys][0])),
    onDragEnd: () => setMoving(null),
    onReorder: event => {
      const id = String([...event.keys][0]);
      move(id, dropIndex(latest.current, id, event.target));
    },
    renderDropIndicator: target => (
      <DropIndicator target={target} className="dropline">
        {({ isDropTarget }) =>
          isDropTarget && moving ? (
            <span>
              {byId.get(moving)?.label}, {ordinal(dropIndex(order, moving, target) + 1)}
            </span>
          ) : null
        }
      </DropIndicator>
    ),
  });

  return (
    <EnglishOnly>
      <GridList
        aria-label={label}
        items={items}
        // The library caches a row by its item; a row's number and its menu depend on the order, so the order (and the
        // caller's render function) invalidate it. Without this the numbers on screen stayed stale after a move.
        dependencies={[order.join('\n'), children, disabled, cols]}
        dragAndDropHooks={dragAndDropHooks}
        keyboardNavigationBehavior="tab"
        className="ds-list"
      >
        {item => {
          const index = order.indexOf(item.id);
          const last = order.length - 1;
          return (
            <GridListItem
              id={item.id}
              textValue={item.label}
              className="row ds-row"
              style={{ gridTemplateColumns: disabled ? cols : `auto ${cols}` }}
            >
              {disabled ? null : (
                <>
                  <Button
                    slot="drag"
                    className="grip ds-drag"
                    aria-label={`Move ${item.label}`}
                    data-focus-key={`drag-${item.id}`}
                  >
                    <GripIcon />
                  </Button>
                  <ActionMenu
                    label={`Move ${item.label}`}
                    className="grip ds-move"
                    focusKey={`drag-${item.id}`}
                    items={[
                      {
                        id: 'top',
                        label: 'To the top',
                        disabled: index === 0,
                        onAction: () => move(item.id, 0),
                      },
                      {
                        id: 'up',
                        label: 'Up one',
                        disabled: index === 0,
                        onAction: () => move(item.id, index - 1),
                      },
                      {
                        id: 'down',
                        label: 'Down one',
                        disabled: index === last,
                        onAction: () => move(item.id, index + 1),
                      },
                      {
                        id: 'bottom',
                        label: 'To the bottom',
                        disabled: index === last,
                        onAction: () => move(item.id, last),
                      },
                    ]}
                  >
                    <GripIcon />
                  </ActionMenu>
                </>
              )}
              {children(item, index)}
            </GridListItem>
          );
        }}
      </GridList>
      <Announcer message={message} />
    </EnglishOnly>
  );
}
