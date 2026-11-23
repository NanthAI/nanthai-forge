// SPDX-License-Identifier: Apache-2.0
// A Dock region's content has one React owner. Each zone places that content's host in its own
// GridList row, and renders its own drag grip into the region header under the GridList's context.
import { useCallback, useEffect, useState, type PointerEventHandler } from 'react';
import { createPortal } from 'react-dom';
import type { DockRegion } from './behaviour';
import { SoloRegionProvider } from './solo-region';

type RegionHosts = { body: HTMLDivElement; grip: HTMLSpanElement };
export type DockHosts = ReadonlyMap<string, RegionHosts>;

function makeHost<Tag extends 'div' | 'span'>(tag: Tag) {
  const host = document.createElement(tag);
  host.style.display = 'contents';
  if (tag === 'div') host.dataset.dockBody = '';
  return host;
}

function useDockHosts(regions: readonly DockRegion[]): DockHosts {
  const [hosts, setHosts] = useState<DockHosts>(() => new Map());
  if (hosts.size === regions.length && regions.every(region => hosts.has(region.id))) return hosts;
  const next = new Map(
    regions.map(({ id }) => [id, hosts.get(id) ?? { body: makeHost('div'), grip: makeHost('span') }]),
  );
  setHosts(next);
  return next;
}

export function DockMount({ host, onAttach }: { host: HTMLElement; onAttach?: (host: HTMLElement) => void }) {
  const Tag = host.tagName === 'SPAN' ? 'span' : 'div';
  const attach = useCallback(
    (slot: HTMLElement | null) => {
      if (!slot || host.parentElement === slot) return;
      slot.append(host);
      onAttach?.(host);
    },
    [host, onAttach],
  );
  return <Tag style={{ display: 'contents' }} ref={attach} />;
}

export function useDockRegions(regions: readonly DockRegion[]) {
  const hosts = useDockHosts(regions);
  const [connected, setConnected] = useState<ReadonlySet<HTMLElement>>(() => new Set());
  const onAttach = useCallback(
    (host: HTMLElement) => {
      setConnected(seen => {
        if (seen.has(host)) return seen;
        const current = [...hosts.values()].map(region => region.body).filter(body => seen.has(body));
        return new Set([...current, host]);
      });
    },
    [hosts],
  );
  // A region may measure its width in a layout effect. First mount it only after its host is attached.
  // Keep it mounted while the host moves between rows or from first paint to the behaviour layer.
  const content = regions.map(region => {
    const host = hosts.get(region.id)!;
    // One region has nothing to be moved among: no handle, and its Region draws no header bar (solo-region.ts).
    const solo = regions.length === 1;
    return connected.has(host.body)
      ? createPortal(
          <SoloRegionProvider value={solo}>
            {region.render(solo ? undefined : <DockMount host={host.grip} />)}
          </SoloRegionProvider>,
          host.body,
          region.id,
        )
      : null;
  });
  return { hosts, content, onAttach };
}

/** An in-flight pointer press must finish on the first-paint control, even if the layer arrives meanwhile. */
export function useHeldPress() {
  const [pointer, setPointer] = useState<number>();
  useEffect(() => {
    if (pointer === undefined) return;
    let frame = 0;
    const release = () => {
      cancelAnimationFrame(frame);
      // Pointer-up precedes click. Let the native button receive that click before swapping.
      frame = requestAnimationFrame(() => setPointer(undefined));
    };
    const finish = (event: PointerEvent) => {
      if (event.pointerId === pointer) release();
    };
    window.addEventListener('pointerup', finish, true);
    window.addEventListener('pointercancel', finish, true);
    window.addEventListener('blur', release);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointerup', finish, true);
      window.removeEventListener('pointercancel', finish, true);
      window.removeEventListener('blur', release);
    };
  }, [pointer]);
  const hold: PointerEventHandler<HTMLButtonElement> = event => {
    if (event.isPrimary && event.button === 0) setPointer(event.pointerId);
  };
  return { held: pointer !== undefined, hold, release: () => setPointer(undefined) };
}
