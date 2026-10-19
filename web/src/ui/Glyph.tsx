// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';

/** 16-unit stroke glyphs. Status glyphs carry meaning alongside colour; concept glyphs identify Forge records. */
const s = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;
const paths = {
  active: <circle cx="8" cy="8" r="4.5" fill="currentColor" />,
  waiting: (
    <>
      <circle cx="8" cy="8" r="5.5" {...s} />
      <path d="M8 5v3.2l2 1.3" {...s} />
    </>
  ),
  stale: <circle cx="8" cy="8" r="5.5" {...s} strokeDasharray="2.4 2.2" />,
  conflict: <path d="M3 3.5 7 8l-4 4.5M13 3.5 9 8l4 4.5" {...s} strokeWidth={1.7} />,
  passed: <path d="m3.3 8.4 3 3 6.4-6.8" {...s} strokeWidth={1.8} />,
  failed: <path d="m4 4 8 8M12 4l-8 8" {...s} strokeWidth={1.8} />,
  running: <path d="M8 2.6A5.4 5.4 0 1 1 2.6 8" {...s} strokeWidth={1.7} />,
  plain: <circle cx="8" cy="8" r="2.5" fill="currentColor" />,
  intent: (
    <>
      <circle cx="8" cy="8" r="6" {...s} />
      <circle cx="8" cy="8" r="2.5" {...s} />
    </>
  ),
  lane: (
    <>
      <circle cx="4.5" cy="3.5" r="1.75" {...s} />
      <circle cx="4.5" cy="12.5" r="1.75" {...s} />
      <circle cx="11.5" cy="6" r="1.75" {...s} />
      <path d="M4.5 5.25v5.5M11.5 7.75c0 2.6-3 2.6-6 3.6" {...s} />
    </>
  ),
  initiative: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" {...s} strokeWidth={1.6} />
      <path d="M5.5 6h5M5.5 8.5h5M5.5 11h3" {...s} strokeWidth={1.6} />
    </>
  ),
  view: (
    <>
      <path d="m8 2 6 3.2L8 8.4 2 5.2z" {...s} />
      <path d="m2 8.4 6 3.2 6-3.2M2 11.4l6 3.2 6-3.2" {...s} />
    </>
  ),
  check: (
    <>
      <rect x="2" y="2" width="12" height="12" rx="3" {...s} />
      <path d="m5.2 8.2 2 2 3.6-4" {...s} />
    </>
  ),
  channel: (
    <>
      <circle cx="4.5" cy="3.5" r="1.75" {...s} />
      <circle cx="4.5" cy="12.5" r="1.75" {...s} />
      <circle cx="11.5" cy="12.5" r="1.75" {...s} />
      <path d="M4.5 5.25v5.5M4.5 5.5c0 4 3.4 5.4 5.3 6.5" {...s} />
    </>
  ),
  overlap: (
    <>
      <rect x="1.75" y="1.75" width="8" height="8" rx="1.5" {...s} />
      <rect x="6.25" y="6.25" width="8" height="8" rx="1.5" {...s} />
    </>
  ),
  handoff: <path d="M2 8h9M8 4.5 11.5 8 8 11.5M14 3v10" {...s} />,
  message: <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" {...s} />,
  review: (
    <>
      <path d="M3.5 1.75h6l3 3v9.5h-9z" {...s} />
      <path d="m5.8 9.2 1.7 1.7 3-3.2" {...s} />
    </>
  ),
  folder: <path d="M1.5 4h5l1.25 1.5h6.75v7H1.5zM1.5 4V2.5h5L8 4" {...s} />,
  file: <path d="M4 1.75h5.5l2.75 2.75v9.75H4z" {...s} />,
  claim: <path d="M3.5 14V2.5h8.5l-2 3 2 3H3.5" {...s} />,
  bell: <path d="M4 11V7a4 4 0 0 1 8 0v4l1.2 1.5H2.8zM6.5 14h3" {...s} />,
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" {...s} />
      <path d="m10.5 10.5 3.5 3.5" {...s} />
    </>
  ),
  chevron: <path d="m6 4 4 4-4 4" {...s} />,
  down: <path d="m4 6 4 4 4-4" {...s} />,
  back: <path d="M10 4 6 8l4 4" {...s} />,
  more: (
    <>
      <circle cx="3.5" cy="8" r="1.2" fill="currentColor" />
      <circle cx="8" cy="8" r="1.2" fill="currentColor" />
      <circle cx="12.5" cy="8" r="1.2" fill="currentColor" />
    </>
  ),
  terminal: <path d="M3 4.5 6.5 8 3 11.5M8.5 12H13" {...s} />,
  sync: <path d="M13 6.5a5 5 0 0 0-9.4-1.7M3 9.5a5 5 0 0 0 9.4 1.7M3.2 2v3h3M12.8 14v-3h-3" {...s} />,
  info: (
    <>
      <circle cx="8" cy="8" r="6" {...s} />
      <path d="M8 7.2v4M8 4.8v.1" {...s} strokeWidth={1.7} />
    </>
  ),
  sun: (
    <>
      <circle cx="8" cy="8" r="2.8" {...s} />
      <path
        d="M8 1.5v1.3M8 13.2v1.3M1.5 8h1.3M13.2 8h1.3M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9"
        {...s}
      />
    </>
  ),
  moon: <path d="M13 9.6A5.5 5.5 0 0 1 6.4 3a5.5 5.5 0 1 0 6.6 6.6z" {...s} />,
  system: (
    <>
      <rect x="2" y="2.75" width="12" height="8.5" rx="1.5" {...s} />
      <path d="M5.5 13.75h5" {...s} />
    </>
  ),
  plus: <path d="M8 3v10M3 8h10" {...s} />,
  close: <path d="m4 4 8 8M12 4l-8 8" {...s} />,
  arrow: <path d="M3 8h10M9 4l4 4-4 4" {...s} />,
  external: <path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5M12 9.5v4H2.5V4h4" {...s} />,
  graph: (
    <>
      <circle cx="4" cy="4" r="1.8" {...s} />
      <circle cx="12" cy="5" r="1.8" {...s} />
      <circle cx="7" cy="12" r="1.8" {...s} />
      <path d="m5.7 4.3 4.5.5M4.8 5.6l1.5 4.6M11 6.5l-3 4" {...s} />
    </>
  ),
  now: <path d="M1.5 8h3l2-4.5 3 9 2-4.5h3" {...s} />,
  code: <path d="M5.5 4 1.5 8l4 4M10.5 4l4 4-4 4" {...s} />,
  settings: (
    <>
      <circle cx="8" cy="8" r="2.2" {...s} />
      <path
        d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"
        {...s}
      />
    </>
  ),
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" {...s} />
      <path d="M10.5 3.5v-1h-8v8h1" {...s} />
    </>
  ),
  agent: (
    <>
      <rect x="2.5" y="4.5" width="11" height="8.5" rx="2.5" {...s} />
      <path d="M8 2v2.5M6 8.5v.5M10 8.5v.5" {...s} strokeWidth={1.7} />
    </>
  ),
  person: (
    <>
      <circle cx="8" cy="5.5" r="2.8" {...s} />
      <path d="M2.8 14c.6-2.8 2.7-4.2 5.2-4.2s4.6 1.4 5.2 4.2" {...s} />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type GlyphName = keyof typeof paths;

export function Glyph({
  name,
  size = 14,
  className,
  label,
}: {
  name: GlyphName;
  size?: number;
  className?: string;
  label?: string;
}) {
  return (
    <svg
      className={className ? `fx-glyph ${className}` : 'fx-glyph'}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}
