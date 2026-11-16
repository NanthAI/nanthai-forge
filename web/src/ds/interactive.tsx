// SPDX-License-Identifier: Apache-2.0
// The interactive parts as screens use them. Each draws its resting shape at first paint without the behaviour layer,
// asks for the layer on the first press or focus (or once when idle), and swaps to the layer's part when it arrives,
// keeping focus on the same control. A press made before the layer arrived is carried out when it does.
import { useLayoutEffect, useRef, useState, type FocusEvent } from 'react';
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

/** Same as the layer's default (behaviour/ReorderList.tsx), so the first-paint rows line up with the swapped ones. */
const LIST_COLS = 'auto auto minmax(0, 1fr) auto';

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
  const [pressed, setPressed] = useState(false);
  const focusKey = props.focusKey ?? `menu-${props.label}`;
  if (layer)
    return <layer.ActionMenu {...props} focusKey={focusKey} defaultOpen={pressed} autoFocus={pressed} />;
  return (
    <button
      type="button"
      className={props.className ?? 'btn'}
      aria-haspopup="menu"
      aria-expanded="false"
      aria-label={props.children ? props.label : undefined}
      data-focus-key={focusKey}
      onFocus={ask}
      onPointerEnter={ask}
      onClick={event => {
        // Kept here when this key outlives the swap; inside a list or a dock the wrapper carries it (markPress).
        setPressed(true);
        markPress(event.currentTarget, focusKey);
        ask();
      }}
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

function Grip({ label, focusKey }: { label: string; focusKey: string }) {
  return (
    <button
      type="button"
      className="grip"
      aria-label={label}
      data-focus-key={focusKey}
      onFocus={ask}
      onPointerDown={ask}
      onClick={event => {
        // Kept until the layer arrives, then carried out on the same handle (useSwapFocus).
        markPress(event.currentTarget, focusKey);
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
  return (
    <div ref={box} onFocus={onFocus} className="ds-swap">
      {layer ? (
        <layer.ReorderList {...props} />
      ) : (
        <div role="list" aria-label={props.label} className="ds-list">
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
  const { box, onFocus } = useSwapFocus(!!layer);
  const byId = new Map(props.regions.map(region => [region.id, region] as const));
  return (
    <div ref={box} onFocus={onFocus} className="ds-swap">
      {layer ? (
        <layer.Dock {...props} />
      ) : (
        <div className="dock" role="group" aria-label={props.label}>
          {(['top', 'a', 'b'] as const).map(zone => (
            <div key={zone} className="zone" data-zone={zone}>
              {props.layout[zone].map(id => {
                const region = byId.get(id);
                return region ? (
                  <div key={id} className="ds-region">
                    {region.render(<Grip label={`Move ${region.title}`} focusKey={`drag-${id}`} />)}
                  </div>
                ) : null;
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Layout of a dock kept on this browser per screen; written only when the reader moves a region. */
export function useDockLayout(
  screen: string,
  initial: DockLayout,
): [DockLayout, (next: DockLayout) => void, () => void] {
  const key = `forge.dock.${screen}`;
  const [layout, setLayout] = useState<DockLayout>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? 'null') as DockLayout | null;
      const ids = (l: DockLayout) => [...l.top, ...l.a, ...l.b].sort().join();
      return saved && ids(saved) === ids(initial) ? saved : initial;
    } catch {
      return initial;
    }
  });
  const save = (next: DockLayout) => {
    setLayout(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // kept for this visit only
    }
  };
  const reset = () => {
    setLayout(initial);
    try {
      localStorage.removeItem(key);
    } catch {
      // nothing stored
    }
  };
  return [layout, save, reset];
}
