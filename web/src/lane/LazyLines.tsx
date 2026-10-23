// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Keep offscreen rows out of React/DOM while retaining their exact scroll extent. */
function Chunk({
  children,
  height,
  initial,
  columns,
}: {
  children: () => ReactNode;
  height: number;
  initial: boolean;
  columns?: number;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(initial);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(entries => setVisible(entries[0]!.isIntersecting), {
      rootMargin: '600px 0px',
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  if (columns)
    return (
      <tbody
        ref={element => {
          ref.current = element;
        }}
      >
        {visible ? (
          children()
        ) : (
          <tr aria-hidden="true" style={{ height }}>
            <td colSpan={columns} style={{ padding: 0 }} />
          </tr>
        )}
      </tbody>
    );
  return (
    <div
      ref={element => {
        ref.current = element;
      }}
      style={{ minHeight: height }}
    >
      {visible ? children() : null}
    </div>
  );
}
export function LazyLines({
  count,
  height,
  render,
  columns,
}: {
  count: number;
  height: number;
  render: (start: number, end: number) => ReactNode;
  columns?: number;
}) {
  if (count <= 200) return columns ? <tbody>{render(0, count)}</tbody> : render(0, count);
  return Array.from({ length: Math.ceil(count / 100) }, (_, index) => {
    const start = index * 100,
      end = Math.min(count, start + 100);
    return (
      <Chunk key={index} columns={columns} height={(end - start) * height} initial={index === 0}>
        {() => render(start, end)}
      </Chunk>
    );
  });
}
