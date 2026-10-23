// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from 'react';

/** Preserve the basename before shortening it; the full path stays on the file button. */
export function fitPath(path: string, fits: (text: string) => boolean): string {
  if (fits(path)) return path;
  const parts = path.split('/'),
    file = parts.at(-1)!;
  for (const text of [`${parts[0]}/…/${file}`, `…/${file}`, file])
    if (parts.length > 1 && fits(text)) return text;
  const chars = Array.from(file);
  let low = 0,
    high = chars.length - 1;
  while (low < high) {
    const keep = Math.ceil((low + high) / 2);
    const text = `${chars.slice(0, Math.ceil(keep / 2)).join('')}…${chars.slice(chars.length - Math.floor(keep / 2)).join('')}`;
    if (fits(text)) low = keep;
    else high = keep - 1;
  }
  return `${chars.slice(0, Math.ceil(low / 2)).join('')}…${chars.slice(chars.length - Math.floor(low / 2)).join('')}`;
}
export function PathLabel({ path }: { path: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [label, setLabel] = useState(path);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const context = document.createElement('canvas').getContext('2d');
    if (!context) return;
    const observer = new ResizeObserver(([entry]) => {
      context.font = getComputedStyle(element).font;
      setLabel(fitPath(path, text => context.measureText(text).width <= entry!.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [path]);
  return (
    <span ref={ref} className="fx-file-name">
      {label}
    </span>
  );
}
