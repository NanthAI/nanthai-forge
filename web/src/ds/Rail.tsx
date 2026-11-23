// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { followLink } from '../app/router';

type RailPlace = {
  id: string;
  label: string;
  href: string;
  icon: ReactNode;
  shortcut?: string;
  badge?: ReactNode;
  current?: 'page' | 'true' | undefined;
  marked?: boolean;
  pages?: ReactNode;
  flyPages?: ReactNode;
};

type Flyout = { id: string; pinned: boolean };
const focusable = '.rail-fly .page-link';

function useRailFlyout(shut: boolean, address: unknown) {
  const [fly, setFly] = useState<Flyout | null>(null);
  const [ready, setReady] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pin = useRef(false);
  const restore = useRef(false);
  const enter = useRef<string | undefined>(undefined);
  const cancel = () => clearTimeout(timer.current);
  const close = () => {
    cancel();
    enter.current = undefined;
    setFly(null);
  };
  useEffect(() => {
    setReady(true);
    return cancel;
  }, []);
  useLayoutEffect(() => {
    const icon = document.activeElement
      ?.closest('.rail-fly')
      ?.closest('.rail-place')
      ?.querySelector<HTMLElement>('.rail-link');
    restore.current = true;
    icon?.focus();
    restore.current = false;
    close();
  }, [address, shut]);
  useEffect(() => {
    if (!fly?.pinned) return;
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || event.target.closest('.rail-place')?.id !== fly.id) close();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [fly]);
  const schedule = (target: HTMLElement, token: '--fly-open' | '--fly-close', run: () => void) => {
    cancel();
    timer.current = setTimeout(run, parseFloat(getComputedStyle(target).getPropertyValue(token)));
  };
  const show = (id: string, pinned = false) => {
    cancel();
    setFly({ id, pinned });
  };
  const onKeys = (event: KeyboardEvent<HTMLElement>, id: string) => {
    if (!shut || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const group = event.currentTarget;
    const icon = group.querySelector<HTMLElement>('.rail-link')!;
    if (!(event.target instanceof Node) || !group.contains(event.target)) return;
    const rows = [...group.querySelectorAll<HTMLElement>(focusable)];
    const index = rows.indexOf(event.target as HTMLElement);
    if (event.target === icon && ['ArrowRight', 'ArrowDown'].includes(event.key) && rows.length) {
      event.preventDefault();
      enter.current = id;
      show(id);
    } else if (event.key === 'Escape' || (index >= 0 && event.key === 'ArrowLeft')) {
      if (fly?.id !== id) return;
      event.preventDefault();
      event.stopPropagation();
      restore.current = true;
      icon.focus();
      restore.current = false;
      close();
    } else if (index >= 0 && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      const step = event.key === 'ArrowUp' ? -1 : 1;
      rows[(index + step + rows.length) % rows.length]?.focus();
    }
  };
  return { fly, ready, pin, restore, enter, cancel, close, schedule, show, onKeys };
}

export function Rail({
  label,
  places,
  shut,
  toggle,
  address,
  heading,
  bottom,
}: {
  label: string;
  places: readonly RailPlace[];
  shut: boolean;
  toggle: () => void;
  address: unknown;
  heading?: string;
  bottom?: ReactNode;
}) {
  const state = useRailFlyout(shut, address);
  const list = useRef<HTMLDivElement>(null);
  const nav = useRef<HTMLElement>(null);
  // The place numbers are keys, not counts: they are drawn only while Alt (Option) is held (rail.css), and the Keys
  // sheet says so. Set on the element itself, so a press redraws nothing and asks for nothing.
  useEffect(() => {
    const show = (on: boolean) => nav.current?.toggleAttribute('data-keys', on);
    const down = (event: globalThis.KeyboardEvent) => event.key === 'Alt' && show(true);
    const up = (event: globalThis.KeyboardEvent) => event.key === 'Alt' && show(false);
    const off = () => show(false);
    addEventListener('keydown', down);
    addEventListener('keyup', up);
    addEventListener('blur', off);
    return () => {
      removeEventListener('keydown', down);
      removeEventListener('keyup', up);
      removeEventListener('blur', off);
    };
  }, []);
  useLayoutEffect(() => {
    if (!state.fly) return;
    const group = document.getElementById(state.fly.id);
    const flyout = group?.querySelector<HTMLElement>('.rail-fly');
    if (!group || !flyout) return;
    const align = () => {
      const top = Math.max(
        48,
        Math.min(group.getBoundingClientRect().top - 5, window.innerHeight - flyout.offsetHeight - 6),
      );
      flyout.style.top = `${top}px`;
      flyout.style.marginBlockStart = '0';
    };
    align();
    const scroller = list.current;
    scroller?.addEventListener('scroll', align, { passive: true });
    addEventListener('resize', align);
    if (state.enter.current === state.fly.id) {
      state.enter.current = undefined;
      (
        flyout.querySelector<HTMLElement>('.page-link[aria-current]') ??
        flyout.querySelector<HTMLElement>('.page-link')
      )?.focus();
    }
    return () => {
      scroller?.removeEventListener('scroll', align);
      removeEventListener('resize', align);
    };
  }, [state.fly, state.enter, places]);
  const clickPlace = (event: MouseEvent<HTMLAnchorElement>, place: RailPlace) => {
    const touch = state.pin.current || matchMedia('(hover: none)').matches;
    state.pin.current = false;
    if (
      shut &&
      place.flyPages &&
      touch &&
      event.detail > 0 &&
      !event.altKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey
    ) {
      event.preventDefault();
      if (state.fly?.id === place.id && state.fly.pinned) state.close();
      else state.show(place.id, true);
      return;
    }
    followLink(event);
    if (event.defaultPrevented) state.close();
  };
  const toggleLabel = shut ? 'Expand sidebar' : 'Collapse sidebar';
  return (
    <nav ref={nav} className="rail" aria-label={label} data-fly-ready={state.ready || undefined}>
      <div className="rail-list" id="sidebar-places" ref={list}>
        {heading ? <div className="rail-heading">{heading}</div> : null}
        {places.map(place => (
          <div
            className="rail-place"
            id={place.id}
            key={place.id}
            data-fly={state.fly?.id === place.id || undefined}
            onPointerEnter={event => {
              if (!shut || event.pointerType === 'touch') return;
              if (
                state.fly?.id !== place.id &&
                (state.fly?.pinned || document.activeElement?.closest('.rail-fly'))
              )
                return;
              state.cancel();
              if (state.fly?.id === place.id) return;
              const show = () => state.show(place.id);
              if (state.fly) show();
              else state.schedule(event.currentTarget, '--fly-open', show);
            }}
            onPointerLeave={event => {
              if (!shut || event.pointerType === 'touch' || state.fly?.pinned) return;
              const focused = event.currentTarget.querySelector(':focus-visible');
              if (focused) return;
              state.schedule(event.currentTarget, '--fly-close', state.close);
            }}
            onFocus={event => {
              if (!shut || state.pin.current || state.restore.current || state.fly?.id === place.id) return;
              if (event.target instanceof Node && event.currentTarget.contains(event.target))
                state.show(place.id);
            }}
            onBlur={event => {
              if (!shut || event.currentTarget.contains(event.relatedTarget)) return;
              if (event.currentTarget.querySelector('.rail-fly button[aria-expanded="true"]')) return;
              state.close();
            }}
            onKeyDown={event => state.onKeys(event, place.id)}
          >
            <a
              className="rail-link"
              href={place.href}
              aria-current={place.current}
              data-marked={place.marked || undefined}
              aria-keyshortcuts={place.shortcut}
              onPointerDown={event => {
                state.pin.current = event.pointerType === 'touch';
              }}
              onPointerCancel={() => {
                state.pin.current = false;
              }}
              onClick={event => clickPlace(event, place)}
            >
              {place.icon}
              <span className="rail-label cut">{place.label}</span>
              {place.badge ? (
                <span aria-hidden={shut || undefined}>{place.badge}</span>
              ) : place.shortcut ? (
                <kbd aria-hidden="true">{place.shortcut}</kbd>
              ) : null}
            </a>
            {shut ? (
              <div className="rail-fly rail-pages" role="group" aria-label={`${place.label} pages`}>
                <div className="rail-fly-box">
                  <div className="rail-fly-title">
                    {place.label}
                    {place.shortcut ? <kbd aria-hidden="true">{place.shortcut}</kbd> : null}
                  </div>
                  {place.flyPages}
                </div>
              </div>
            ) : place.pages ? (
              <div className="rail-sub rail-pages" role="group" aria-label={`${place.label} pages`}>
                {place.pages}
              </div>
            ) : null}
          </div>
        ))}
        {bottom}
      </div>
      <div className="rail-foot">
        <button
          type="button"
          className="rail-toggle"
          aria-label={toggleLabel}
          aria-expanded={!shut}
          aria-controls="sidebar-places"
          aria-keyshortcuts="["
          onClick={toggle}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M2 3h12v10H2zM6 3v10M11 6l-2 2 2 2" />
          </svg>
          <span className="rail-label">{shut ? 'Expand' : 'Collapse'}</span>
          <kbd aria-hidden="true">[</kbd>
        </button>
      </div>
    </nav>
  );
}
