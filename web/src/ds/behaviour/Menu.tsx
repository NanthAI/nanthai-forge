// SPDX-License-Identifier: Apache-2.0
// The one menu: a key that opens a list of actions. Arrow keys move, Enter runs, Escape closes and focus returns to
// the key. Loaded with the behaviour layer; screens use ds/menu.tsx, which draws the same key at first paint.
import { useState, type ReactNode } from 'react';
import { Button, Menu, MenuItem, MenuTrigger, Popover, Separator } from 'react-aria-components';
import { EnglishOnly } from './shared';

export type MenuAction =
  | { id: string; label: string; keys?: string; danger?: boolean; disabled?: boolean; onAction: () => void }
  | 'separator';

export type ActionMenuProps = {
  /** Accessible name of the key; also its visible text unless `children` draws the key. */
  label: string;
  items: readonly MenuAction[];
  children?: ReactNode;
  className?: string;
  /** Opened by a press that arrived before the layer: open at once and keep focus on the key. */
  defaultOpen?: boolean;
  autoFocus?: boolean;
  placement?: 'bottom start' | 'bottom end';
  /** Matches the first-paint control this key replaces (ds/interactive.tsx keeps focus and a pending press). */
  focusKey?: string;
  /** The Dock grip opens on click and lets the drag slot handle Enter. */
  dragHandle?: boolean;
};

export function ActionMenu({
  label,
  items,
  children,
  className = 'btn',
  defaultOpen,
  autoFocus,
  placement = 'bottom start',
  focusKey,
  dragHandle,
}: ActionMenuProps) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const run = (key: React.Key) => {
    const item = items.find(entry => entry !== 'separator' && entry.id === key);
    if (item && item !== 'separator') item.onAction();
  };
  return (
    <EnglishOnly>
      <MenuTrigger
        {...(dragHandle ? { trigger: 'contextMenu', isOpen: open, onOpenChange: setOpen } : { defaultOpen })}
      >
        <Button
          className={className}
          data-focus-key={focusKey}
          aria-label={children ? label : undefined}
          autoFocus={autoFocus}
          slot={dragHandle ? 'drag' : undefined}
          style={dragHandle ? { pointerEvents: 'auto' } : undefined}
          render={dragHandle ? props => <button {...props} draggable /> : undefined}
          onPress={
            dragHandle
              ? event => {
                  if (event.pointerType !== 'keyboard' && event.pointerType !== 'virtual')
                    setOpen(value => !value);
                }
              : undefined
          }
          onKeyDown={
            dragHandle
              ? event => {
                  if (event.altKey && event.key === 'ArrowDown') {
                    event.preventDefault();
                    setOpen(true);
                  }
                }
              : undefined
          }
        >
          {children ?? <span>{label}</span>}
        </Button>
        <Popover className="ds-pop" placement={placement} offset={4}>
          <Menu className="menu" onAction={run} aria-label={label}>
            {items.map((item, index) =>
              item === 'separator' ? (
                <Separator key={`separator-${index}`} className="sep" />
              ) : (
                <MenuItem
                  key={item.id}
                  id={item.id}
                  className={item.danger ? 'mi danger' : 'mi'}
                  isDisabled={item.disabled}
                  textValue={item.label}
                >
                  <span>{item.label}</span>
                  {item.keys ? <kbd aria-hidden="true">{item.keys}</kbd> : null}
                </MenuItem>
              ),
            )}
          </Menu>
        </Popover>
      </MenuTrigger>
    </EnglishOnly>
  );
}
