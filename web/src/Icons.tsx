// SPDX-License-Identifier: Apache-2.0
import { Glyph } from './ui/Glyph';
export type ConceptName =
  | 'project'
  | 'intent'
  | 'issue'
  | 'initiative'
  | 'lane'
  | 'view'
  | 'check-run'
  | 'channel'
  | 'proposal'
  | 'release';
export type IconName =
  | ConceptName
  | 'source-review'
  | 'graph'
  | 'home'
  | 'code'
  | 'work'
  | 'agents'
  | 'activity'
  | 'settings'
  | 'arrow'
  | 'plus'
  | 'search'
  | 'close'
  | 'check'
  | 'clock'
  | 'pause'
  | 'alert'
  | 'review'
  | 'branch';
const paths: Record<Exclude<IconName, 'settings'>, string> = {
  'source-review': 'M9 21H3V3h10l4 4v2M13 3v5h4M6 7h3m-3 4h3M12 15a4 4 0 1 0 8 0 4 4 0 0 0-8 0m7 3 3 3',
  project: 'M3 6h7l2 3h9v11H3V6zm0 3h9',
  intent: 'M5 21V3m0 1h13l-3 4 3 4H5',
  issue: 'M4 4h16v16H4V4zm8 4v5m0 3v.1',
  initiative: 'M4 21V3m0 1h10l-2 3 2 3H4m5 3h11l-2 3 2 3H9v-6',
  lane: 'M6 5v14m12-14v3c0 4-12 4-12 8m-2-13h4v4H4V3zm12 0h4v4h-4V3zM4 17h4v4H4v-4',
  view: 'M3 4v4c0 4 6 3 6 7m12-11v4c0 4-6 3-6 7M7 15h10v6H7v-6',
  'check-run': 'M4 3h12l4 4v14H4V3zm12 0v5h4M7 13l3 3 6-6',
  channel: 'M3 16h18m-4-4 4 4-4 4M7 8v8M4 3h6v5H4V3',
  proposal: 'M13 3h8v18h-8M3 12h13m-4-4 4 4-4 4',
  release: 'M3 7l9-4 9 4v11l-9 4-9-4V7zm0 0l9 5 9-5m-9 5v10',
  check: 'M5 12l4 4L19 6',
  clock: 'M12 8v4l3 2M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0',
  pause: 'M8 5v14M16 5v14',
  alert: 'M12 8v5m0 3v1M12 3 2 21h20L12 3',
  review: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7M9 12a3 3 0 1 0 6 0 3 3 0 0 0-6 0',
  branch: 'M6 3v12a6 6 0 0 0 6 6M6 9h6a6 6 0 0 0 6-6M4 3h4M16 3h4M10 21h4',
  graph: 'M5 6l14 3-9 10L5 6zm0 0l5 13M19 9l-9 10M3 6h4M5 4v4M17 9h4M19 7v4M8 19h4M10 17v4',
  home: 'M3 10l9-7 9 7M5 9v12h5v-7h4v7h5V9',
  code: 'M8 6l-6 6 6 6m8-12 6 6-6 6m-3-15-2 18',
  work: 'M3 7h18v14H3zM8 7V3h8v4M3 12h18M10 12v3h4v-3',
  agents: 'M7 21v-3a5 5 0 0 1 10 0v3M8 7a4 4 0 1 0 8 0 4 4 0 0 0-8 0M3 13v5m18-5v5',
  activity: 'M2 12h4l3-8 5 16 3-8h5',
  arrow: 'M4 12h16m-6-6 6 6-6 6',
  plus: 'M12 4v16M4 12h16',
  search: 'M15 15l6 6M3 9a6 6 0 1 0 12 0A6 6 0 0 0 3 9',
  close: 'M6 6l12 12M6 18 18 6',
};
export function Icon({ name }: { name: IconName }) {
  if (name === 'settings') return <Glyph name="settings" size={20} />;
  return (
    <svg
      aria-hidden="true"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name]} />
    </svg>
  );
}
