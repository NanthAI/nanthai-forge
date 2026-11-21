// SPDX-License-Identifier: Apache-2.0
// The interactive parts as screens use them. Each draws its resting shape at first paint without the behaviour layer,
// asks for the layer on the first press or focus (or once when idle), and swaps to the layer's part when it arrives,
// keeping focus on the same control. A press made before the layer arrived is carried out when it does.
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type MouseEventHandler,
  type PointerEventHandler,
} from 'react';
import { createPortal } from 'react-dom';
import type {
  ActionMenuProps,
  DockLayout,
  DockProps,
  PaletteProps,
  ReorderItem,
  ReorderListProps,
  SheetProps,
} from './behaviour';
import { loadLayer, useLayer } from './layer';
import { DockMount, useDockRegions, useHeldPress } from './dock-regions';

/** Same as the layer's default (behaviour/ReorderList.tsx), so the first-paint rows line up with the swapped ones. */
const LIST_COLS = 'auto auto minmax(0, 1fr) auto';
export const DockPerson = createContext<string | null | undefined>(undefined);

const DOCK_ZONES = ['top', 'a', 'b'] as const;

export type {
  DockLayout,
  DockProps,
  DockRegion,
  DockZone,
  MenuAction,
  PaletteEntry,
  PaletteGroup,
  ReorderItem,
} from './behaviour';

const ask = () => void loadLayer().catch(() => undefined);

/** Marks a press made before the layer arrived on the nearest swapping wrapper, with which of the same-named
 * controls it was, so the wrapper can press the same control once the layer's tree replaces the first-paint one (a
 * menu inside a dock region is remounted then, and its own state is lost). */
function markPress(control: HTMLElement, key: string) {
  const wrapper = control.closest<HTMLElement>('.ds-swap');
  if (!wrapper) return;
  wrapper.dataset.pressedKey = key;
  const same = [...wrapper.querySelectorAll(`[data-focus-key="${CSS.escape(key)}"]`)];
  wrapper.dataset.pressedIndex = String(Math.max(0, same.indexOf(control)));
}

/** Keeps focus on the matching control (same data-focus-key) when the first-paint shape is swapped for the layer's,
 * and carries out a press made before the layer arrived (markPress). A press names which of the same-named controls
 * it was; otherwise the first visible match wins (on a phone that is the handle's menu). */
function useSwapFocus(swapped: boolean) {
  const box = useRef<HTMLDivElement>(null);
  const focused = useRef<string | null>(null);
  const onFocus = (event: FocusEvent) => {
    focused.current =
      (event.target as HTMLElement).closest('[data-focus-key]')?.getAttribute('data-focus-key') ?? null;
  };
  useLayoutEffect(() => {
    const root = box.current;
    const pressed = root?.dataset.pressedKey ?? null;
    const index = root?.dataset.pressedIndex;
    const key = pressed ?? focused.current;
    if (!swapped || !root || !key) return;
    delete root.dataset.pressedKey;
    delete root.dataset.pressedIndex;
    // The layer's lists build their rows in a second render, so the control may not be there yet: look again on the
    // next few frames. This runs once, after a press or focus that asked for the layer; an idle page never gets here.
    let frame = 0;
    let tries = 0;
    const apply = () => {
      const matches = [...root.querySelectorAll<HTMLElement>(`[data-focus-key="${CSS.escape(key)}"]`)];
      const target =
        pressed && index !== undefined && matches.length > 1 && !key.startsWith('drag-')
          ? matches[Number(index)]
          : matches.find(element => element.getClientRects().length > 0);
      if (!target) {
        if (++tries < 10) frame = requestAnimationFrame(apply);
        return;
      }
      const lost = !document.activeElement || document.activeElement === document.body;
      if (lost || pressed) target.focus();
      if (pressed) target.click();
    };
    apply();
    return () => cancelAnimationFrame(frame);
  }, [swapped]);
  return { box, onFocus };
}

/** A key that opens a menu of actions. */
export function Menu(props: ActionMenuProps) {
  const layer = useLayer();
  const { held, hold } = useHeldPress();
  const [pressed, setPressed] = useState(false);
  const [focused, setFocused] = useState(false);
  const focusKey = props.focusKey ?? `menu-${props.label}`;
  if (layer && !held)
    return <layer.ActionMenu {...props} focusKey={focusKey} replayPress={pressed} autoFocus={focused} />;
  const press = (button: HTMLButtonElement) => {
    // Kept here when this key outlives the swap; inside a list or a dock the wrapper carries it.
    setPressed(true);
    markPress(button, focusKey);
    ask();
  };
  return (
    <button
      type="button"
      className={props.className ?? 'btn'}
      aria-haspopup="menu"
      aria-expanded="false"
      aria-current={props['aria-current']}
      aria-label={props.children ? props.label : undefined}
      tabIndex={props.excludeFromTabOrder ? -1 : undefined}
      data-focus-key={focusKey}
      onFocus={() => {
        setFocused(true);
        ask();
      }}
      onBlur={() => setFocused(false)}
      onPointerEnter={ask}
      onPointerDown={hold}
      onKeyDown={event => {
        // Like the loaded menu, Space opens on keydown so attaching the layer cannot swallow its keyup click.
        if (event.key !== ' ') return;
        event.preventDefault();
        if (!event.repeat) press(event.currentTarget);
      }}
      onClick={event => press(event.currentTarget)}
    >
      {props.children ?? <span>{props.label}</span>}
    </button>
  );
}

/** A sheet over the page. While the layer is still on its way an opened sheet waits for it (one idle fetch earlier). */
export function Sheet(props: SheetProps) {
  const layer = useLayer();
  if (props.open && !layer) ask();
  return layer ? <layer.Sheet {...props} /> : null;
}

/** Go to or run (⌘K). */
export function Palette(props: PaletteProps) {
  const layer = useLayer();
  if (props.open && !layer) ask();
  return layer ? <layer.Palette {...props} /> : null;
}

function Grip({
  label,
  focusKey,
  onClick,
  onPointerDown,
}: {
  label: string;
  focusKey: string;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  onPointerDown?: PointerEventHandler<HTMLButtonElement>;
}) {
  return (
    <button
      type="button"
      className="grip"
      aria-label={label}
      data-focus-key={focusKey}
      onFocus={ask}
      onPointerEnter={onClick ? ask : undefined}
      onPointerDown={event => {
        onPointerDown?.(event);
        ask();
      }}
      onClick={event => {
        // Kept until the layer arrives, then carried out on the same handle (useSwapFocus).
        if (onClick) onClick(event);
        else markPress(event.currentTarget, focusKey);
        ask();
      }}
    >
      <svg width="10" height="16" viewBox="0 0 10 16" aria-hidden="true" fill="currentColor">
        {[3, 8, 13].flatMap(y => [
          <circle key={`a${y}`} cx="2.5" cy={y} r="1.4" />,
          <circle key={`b${y}`} cx="7.5" cy={y} r="1.4" />,
        ])}
      </svg>
    </button>
  );
}

/** A list the reader orders by hand (DESIGN.md rule 4). */
export function ReorderList<T extends ReorderItem>(props: ReorderListProps<T>) {
  const layer = useLayer();
  const { box, onFocus } = useSwapFocus(!!layer);
  const keepListHeight = useCallback((list: HTMLDivElement | null) => {
    if (!list) return;
    // The grid commits before its rows. Keep the actual first-paint height during that gap,
    // including wrapped rows, so scroll anchoring cannot move a grip further down the page.
    return () => {
      list.parentElement?.style.setProperty(
        '--ds-first-list-height',
        `${list.getBoundingClientRect().height}px`,
      );
    };
  }, []);
  return (
    <div ref={box} onFocus={onFocus} className="ds-swap">
      {layer ? (
        <layer.ReorderList {...props} />
      ) : (
        <div ref={keepListHeight} role="list" aria-label={props.label} className="ds-list">
          {props.items.map((item, index) => (
            <div
              role="listitem"
              key={item.id}
              className="row ds-row"
              style={{ gridTemplateColumns: `${props.disabled ? '' : 'auto '}${props.cols ?? LIST_COLS}` }}
            >
              {props.disabled ? null : <Grip label={`Move ${item.label}`} focusKey={`drag-${item.id}`} />}
              {props.children(item, index)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A screen's regions: a full-width row and two columns, each region moved by its handle. */
export function Dock(props: DockProps) {
  const layer = useLayer();
  const grip = useHeldPress();
  const activeLayer = grip.held ? null : layer;
  const [initialMenu, setInitialMenu] = useState<string>();
  const { box, onFocus } = useSwapFocus(!!activeLayer);
  const shown = new Set(DOCK_ZONES.flatMap(zone => props.layout[zone]));
  const byId = new Map(
    props.regions.filter(region => shown.has(region.id)).map(region => [region.id, region]),
  );
  const regions = [...byId.values()];
  const { hosts, content, onAttach } = useDockRegions(regions);
  return (
    <div ref={box} onFocus={onFocus} className="ds-swap">
      {activeLayer ? (
        <activeLayer.Dock
          {...props}
          regions={regions}
          hosts={hosts}
          onAttach={onAttach}
          initialMenu={initialMenu}
        />
      ) : (
        <div
          className="dock"
          role="group"
          aria-label={props.label}
          data-shut={DOCK_ZONES.filter(zone => !props.layout[zone].length).join(' ') || undefined}
        >
          {DOCK_ZONES.map(zone => (
            <div key={zone} className="zone" data-zone={zone}>
              {props.layout[zone].map(id => {
                const region = byId.get(id);
                const host = hosts.get(id);
                if (!region || !host) return null;
                return (
                  <div key={id} className="ds-region">
                    <DockMount host={host.body} onAttach={onAttach} />
                    {createPortal(
                      <Grip
                        label={`Move ${region.title}`}
                        focusKey={`drag-${id}`}
                        onPointerDown={grip.hold}
                        onClick={event => {
                          if (event.detail > 0 || matchMedia('(pointer: coarse)').matches) setInitialMenu(id);
                          else markPress(event.currentTarget, `drag-${id}`);
                          grip.release();
                        }}
                      />,
                      host.grip,
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
      {content}
    </div>
  );
}

const sameOrder = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, index) => id === b[index]);

/** Keep a saved layout only while it names exactly the screen's regions. */
export function keptLayout(saved: DockLayout | null, initial: DockLayout): DockLayout {
  if (!saved || !DOCK_ZONES.every(zone => Array.isArray(saved[zone]))) return initial;
  const ids = (layout: DockLayout) => DOCK_ZONES.flatMap(zone => layout[zone]).sort();
  return sameOrder(ids(saved), ids(initial)) ? saved : initial;
}

/** Remember a dock on this browser per person and screen. Moves and resets each touch local storage once. */
export function useDockLayout(
  screen: string,
  initial: DockLayout,
): [DockLayout, (next: DockLayout) => void, () => void, boolean] {
  const person = useContext(DockPerson);
  const key =
    person === null
      ? null
      : person
        ? `forge.dock.person:${encodeURIComponent(person)}:${screen}`
        : `forge.dock.${screen}`;
  const stored = useMemo(() => {
    if (key === null) return null;
    try {
      return JSON.parse(localStorage.getItem(key) ?? 'null') as DockLayout | null;
    } catch {
      return null;
    }
  }, [key]);
  const [edited, setEdited] = useState<{ key: string | null; layout: DockLayout | null } | null>(null);
  const layout = useMemo(
    () => keptLayout(edited?.key === key ? edited.layout : stored, initial),
    [edited, initial, key, stored],
  );
  const save = (next: DockLayout | null) => {
    setEdited({ key, layout: next });
    if (key === null) return;
    try {
      if (next) localStorage.setItem(key, JSON.stringify(next));
      else localStorage.removeItem(key);
    } catch {
      // kept for this visit only
    }
  };
  const moved = DOCK_ZONES.some(zone => !sameOrder(layout[zone], initial[zone]));
  return [layout, save, () => save(null), moved];
}
