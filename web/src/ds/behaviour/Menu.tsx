// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The one menu: a key that opens a list of actions. Arrow keys move, Enter runs, Escape closes and focus returns to
// the key. Loaded with the behaviour layer; screens use ds/menu.tsx, which draws the same key at first paint.
import { useLayoutEffect, useRef, useState, type AriaAttributes, type ReactNode } from 'react';
import {
  Button,
  Menu,
  MenuItem,
  MenuTrigger,
  Popover,
  RouterProvider,
  Separator,
} from 'react-aria-components';
import { EnglishOnly } from './shared';

export type MenuAction =
  | ({ id: string; label: string; keys?: string; danger?: boolean; disabled?: boolean } & (
      | { onAction: () => void; href?: never }
      | { href: string; onAction?: never }
    ))
  | 'separator';

export type ActionMenuProps = {
  /** Accessible name of the key; also its visible text unless `children` draws the key. */
  label: string;
  items: readonly MenuAction[];
  children?: ReactNode;
  className?: string;
  'aria-current'?: AriaAttributes['aria-current'];
  /** Opened by a press that arrived before the layer: open at once and keep focus on the key. */
  defaultOpen?: boolean;
  autoFocus?: boolean;
  /** Replay a first-paint press after the real trigger mounts, so the menu can restore focus to it. */
  replayPress?: boolean;
  placement?: 'bottom start' | 'bottom end' | 'top end';
  /** Matches the first-paint control this key replaces (ds/interactive.tsx keeps focus and a pending press). */
  focusKey?: string;
  /** The Dock grip opens on click and lets the drag slot handle Enter. */
  dragHandle?: boolean;
  /** Arrow navigation reaches this trigger inside a collapsed sidebar. */
  excludeFromTabOrder?: boolean | undefined;
  onNavigate?: (href: string) => void;
};

export function ActionMenu({
  label,
  items,
  children,
  className = 'btn',
  'aria-current': current,
  defaultOpen,
  autoFocus,
  replayPress,
  placement = 'bottom start',
  focusKey,
  dragHandle,
  excludeFromTabOrder,
  onNavigate,
}: ActionMenuProps) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (replayPress) button.current?.click();
  }, [replayPress]);
  const run = (key: React.Key) => {
    const item = items.find(entry => entry !== 'separator' && entry.id === key);
    if (item && item !== 'separator') item.onAction?.();
  };
  const control = (
    <EnglishOnly>
      <MenuTrigger
        {...(dragHandle ? { trigger: 'contextMenu', isOpen: open, onOpenChange: setOpen } : { defaultOpen })}
      >
        <Button
          ref={button}
          className={className}
          data-focus-key={focusKey}
          aria-label={children ? label : undefined}
          aria-current={current}
          autoFocus={autoFocus}
          excludeFromTabOrder={excludeFromTabOrder}
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
        <Popover className="ds-pop" placement={placement} offset={4} scrollRef={menu}>
          <Menu ref={menu} className="menu" onAction={run} aria-label={label}>
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
                  {...(item.href ? { href: item.href } : {})}
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
  return onNavigate ? <RouterProvider navigate={onNavigate}>{control}</RouterProvider> : control;
}
