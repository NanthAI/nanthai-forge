// SPDX-License-Identifier: Apache-2.0
// The places of each frame (DESIGN.md "Frames"; pattern rule 8): the rail's six project places, the account's five,
// the section strip of each place, and the quiet line icon each place shows in the rail and the phone tabs.
import type { AccountPlace, ProjectPlace } from './paths';

export const projectPlaceLabels: Record<ProjectPlace, string> = {
  needs: 'Needs me',
  lanes: 'Lanes',
  plan: 'Plan',
  code: 'Code',
  stats: 'Stats',
  settings: 'Settings',
};
export const accountPlaceLabels: Record<AccountPlace, string> = {
  projects: 'Projects',
  billing: 'Billing',
  people: 'People and teams',
  devices: 'Sign-in and devices',
  data: 'Your data',
};
/** Short names on the phone's tab bar, where 11.5 px labels must fit five across. */
export const accountTabLabels: Partial<Record<AccountPlace, string>> = { people: 'People' };

export const sectionLabels: Record<ProjectPlace, Record<string, string>> = {
  needs: { '': 'Needs me', held: 'Held, redone or refused', 'loose-ends': 'Loose ends' },
  lanes: { '': 'Lanes', history: 'History', touching: 'Who is touching what', sessions: 'Sessions' },
  plan: { '': 'Backlog' },
  code: { '': 'What landed', files: 'Files' },
  stats: { '': 'Stats' },
  settings: {
    '': 'People and access',
    checks: 'Landing and checks',
    mirror: 'GitHub mirror',
    secrets: 'Secrets',
    project: 'Project',
    you: 'You',
  },
};
/** In the settings strip, "You" sits apart at the far end (the strip's gap). */
export const stripGapBefore: Partial<Record<ProjectPlace, string>> = { settings: 'you' };

/** The sentence each place's head states until its rebuilt screen states the real answer. */
export const placeSentence: Record<ProjectPlace, string> = {
  needs: 'What waits on you in this project.',
  lanes: 'Every open Lane and where it is.',
  plan: 'The backlog: Items and Initiatives in order.',
  code: 'What landed on main, and the files at any landing.',
  stats: 'How this project lands: time to main, checks and cost.',
  settings: 'Who can do what in this project.',
};
export const accountSentence: Record<AccountPlace, string> = {
  projects: 'Your projects.',
  billing: 'Your plan and what it has used.',
  people: 'The people and teams you work with.',
  devices: 'Where you are signed in, and your passkeys.',
  data: 'Export your data or delete your account.',
};

type IconName = ProjectPlace | AccountPlace | 'more' | 'find' | 'back';
// 16-unit line drawings at 1.5 px. aria-hidden: the label beside each icon names the place.
const paths: Record<IconName, string> = {
  needs: 'M8 1.5 14.5 8 8 14.5 1.5 8ZM8 5v3.5M8 10.8v.2',
  lanes: 'M3 3v10M8 3v10M13 3v10M1.5 5.5h3M6.5 9h3M11.5 6.5h3',
  plan: 'M2.5 3.5h11M2.5 8h11M2.5 12.5h7',
  code: 'M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4',
  stats: 'M3 13.5V8M8 13.5V3M13 13.5V6M1.5 13.5h13',
  settings:
    'M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4',
  projects: 'M2 3.5h4.5L8 5h6v8.5H2Z',
  billing: 'M1.5 4h13v8h-13ZM1.5 6.5h13M4 10h3',
  people:
    'M6 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM1.5 13.5c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4M11 3a2.2 2.2 0 0 1 0 4.2M12.5 9.7c1.3.5 2 1.8 2 3.8',
  devices: 'M2 3h12v8H2ZM5.5 13.5h5M8 11v2.5',
  data: 'M8 1.5c3.3 0 6 1 6 2.5S11.3 6.5 8 6.5 2 5.5 2 4s2.7-2.5 6-2.5ZM2 4v8c0 1.5 2.7 2.5 6 2.5s6-1 6-2.5V4M2 8c0 1.5 2.7 2.5 6 2.5S14 9.5 14 8',
  more: 'M3.5 8h.01M8 8h.01M12.5 8h.01',
  find: 'M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9ZM10.3 10.3 14 14',
  back: 'M9.5 3.5 5 8l4.5 4.5',
};

export function PlaceIcon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === 'more' ? 2.4 : 1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
