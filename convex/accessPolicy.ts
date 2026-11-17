// SPDX-License-Identifier: Apache-2.0
import { invariant } from '../src/errors';
/** Owner-approved access policies. Each rule has one setting; consumers call the policy. */
export const accessPolicy = {
  laneTakeover: 'same-person-or-project-owner' as 'same-person-or-project-owner' | 'project-writers',
  liveTakeoverReason: true,
  unlinkedImportedViews: 'all-projects-devices' as 'all-projects-devices' | 'person-access',
  deviceNames: 'own-person' as 'own-person' | 'project-members',
  deviceEnd: 'signout-keeps-remove-revokes' as 'signout-keeps-remove-revokes' | 'both-revoke',
};
export const browserInactivitySeconds = 14 * 24 * 60 * 60;
export const browserLifetimeSeconds = 30 * 24 * 60 * 60;
export const mayTakeLane = (actor: string, person: string, projectOwner: string) =>
  accessPolicy.laneTakeover === 'project-writers' || actor === person || actor === projectOwner;
export const takeoverNeedsReason = (live: boolean) => accessPolicy.liveTakeoverReason && live;
export const maySeeDeviceName = (viewer: string, owner: string) =>
  accessPolicy.deviceNames === 'project-members' || viewer === owner;
export const keepsDeviceSettings = (action: 'signout' | 'remove') =>
  accessPolicy.deviceEnd === 'signout-keeps-remove-revokes' && action === 'signout';

export const deviceProjectRefusal =
  'This device is approved for its selected project only. Change its settings in your Forge browser.';
/** Unlinked imported views have no native project association to satisfy a selected-project grant. */
export function requireUnlinkedImportAccess(ctx: object) {
  const device = (ctx as { forgeDevice?: { settings?: { projects: { kind: string } } } | null }).forgeDevice;
  invariant(
    accessPolicy.unlinkedImportedViews === 'person-access' || device?.settings?.projects.kind !== 'project',
    'AUTH_SCOPE_DENIED',
    deviceProjectRefusal,
  );
}
const importedTables = new Set(['imports', 'sourceZones', 'agentGrants', 'savedViews']);
/** Static registration metadata, never request data: covers query/mutation lifecycle siblings too. */
export function usesUnlinkedImport(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const shape = ('json' in value ? value.json : value) as Record<string, unknown>;
  if (shape.type === 'id' && typeof shape.tableName === 'string' && importedTables.has(shape.tableName))
    return true;
  return Object.values(shape).some(usesUnlinkedImport);
}
