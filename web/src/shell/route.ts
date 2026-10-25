// SPDX-License-Identifier: Apache-2.0
/** Primary project destinations. Presentation URLs are encoded by location.ts. */
export type ProjectTab = 'now' | 'intents' | 'code' | 'settings';
export const projectTabs: readonly ProjectTab[] = ['now', 'intents', 'code', 'settings'];

/** Hosted project pages (HostedWork `projectTab`) grouped under the four destinations. */
export const hostedSections = {
  now: ['overview', 'activity', 'coordination'],
  intents: ['intent', 'lanes', 'views', 'planning', 'decisions'],
  code: ['delivery'],
  settings: [
    'sharing',
    'agents',
    'backups',
    'settings',
    'general',
    'autonomy',
    'checks',
    'access',
    'you',
    'appearance',
    'devices',
    'contributions',
    'transfer',
    'github',
  ],
} as const satisfies Record<ProjectTab, readonly string[]>;
export type HostedSection = (typeof hostedSections)[ProjectTab][number];

export function hostedTab(section: string | null): ProjectTab {
  for (const tab of projectTabs)
    if ((hostedSections[tab] as readonly string[]).includes(section ?? '')) return tab;
  return 'now';
}

/** Hosted account destinations outside any project. */
export type AccountTab = 'projects' | 'explore' | 'agents' | 'account';

/** Signed-out visitors only ever see the public landing; signed-in visitors land on their projects. */
export function entryFor(signedIn: boolean, search: string): 'public' | 'account' | 'project' | 'repository' {
  const params = new URLSearchParams(search);
  if (params.has('codescape')) return 'repository';
  if (!signedIn) return 'public';
  return params.get('project') ? 'project' : 'account';
}

/** Planning keeps the existing full-page destinations until the dedicated pages land. */
export function planningDestination(
  target: { kind: 'intent' | 'planning' | 'initiative'; id: string } | { kind: 'list' },
): Record<string, string> {
  if (target.kind === 'intent') return { projectTab: 'intent', intent: target.id };
  if (target.kind === 'list') return { projectTab: 'planning' };
  return { projectTab: 'planning', planningItem: target.id, planningRoute: `${target.kind}:${target.id}` };
}
