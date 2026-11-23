// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { invariant } from '../src/errors';
import { safeRelative } from '../src/safe-relative';
import type { Doc } from './_generated/dataModel';
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
export const deviceAllowsSourceWrite = (device?: Pick<Doc<'cliCredentials'>, 'settings'> | null) =>
  device?.settings?.source !== 'read';

/** Scoped grants (df06081d, owner 2026-11-22): one project and a folder/path set; the grant ends 7 days
 * after its last write or 30 days after it was given, whichever is first. Computed here, at check time. */
export const GRANT_IDLE_MS = 7 * 86400000;
export const GRANT_MAX_MS = 30 * 86400000;
/** Renewal on use writes at most once per grant per hour, never on every request. */
export const GRANT_RENEW_MS = 3600000;
export const GRANT_PATHS = 20;
const GRANT_PATH_CHARS = 200;
type Grant = { at: number; usedAt: number };
type Granted = Pick<Doc<'cliCredentials'>, 'settings' | 'grant'>;
export const grantEndsAt = (grant: Grant) => Math.min(grant.usedAt + GRANT_IDLE_MS, grant.at + GRANT_MAX_MS);
/** A browser approval or settings change gives the grant again; settings without paths have no grant clock. */
export function grantStamp(settings: Doc<'cliCredentials'>['settings'], now = Date.now()) {
  const paths = settings?.paths;
  if (paths === undefined) return { grant: undefined };
  invariant(
    settings!.source === 'write' &&
      settings!.projects.kind === 'project' &&
      paths.length > 0 &&
      paths.length <= GRANT_PATHS &&
      new Set(paths).size === paths.length &&
      paths.every(
        path =>
          path.length <= GRANT_PATH_CHARS && safeRelative(path.endsWith('/') ? path.slice(0, -1) : path),
      ),
    'BAD_ARGUMENT',
    `A folder grant writes to one selected project: 1 to ${GRANT_PATHS} relative folders (ending in /) or files.`,
  );
  return { grant: { at: now, usedAt: now } };
}
export const grantAllows = (paths: readonly string[], path: string) =>
  paths.some(entry => entry === path || (entry.endsWith('/') && path.startsWith(entry)));
/** A write under a scoped grant: refused once it ended. Returns the renewal patch when one is due. */
export function liveGrant(row: Granted | null | undefined, now = Date.now()) {
  if (!row?.settings?.paths) return null;
  invariant(
    row.grant && now < grantEndsAt(row.grant),
    'AUTH_EXPIRED',
    'This device’s folder grant ended (7 days without a write, or 30 days after it was given). Run nforge login and approve it in your Forge browser to grant it again; local work is kept.',
  );
  return now - row.grant.usedAt >= GRANT_RENEW_MS ? { grant: { ...row.grant, usedAt: now } } : null;
}
export function requireGrantPaths(row: Granted | null | undefined, paths: readonly string[]) {
  const scope = row?.settings?.paths;
  if (!scope) return;
  const outside = paths.find(path => !grantAllows(scope, path));
  invariant(
    outside === undefined,
    'AUTH_SCOPE_DENIED',
    `This device may write only to ${scope.join(', ')}; ${outside} is outside its folder grant. Nothing was saved; local work is kept.`,
  );
}

/** A landing submitted by a folder-grant device carries that grant (df06081d), taken from the guard's
 * credential row: no read. People and whole-project devices carry none. */
export type LandingGrant = { credentialId: string; paths: string[] };
export function landingGrantStamp(ctx: object): { grant?: LandingGrant } {
  const device = (ctx as { forgeDevice?: Doc<'cliCredentials'> | null }).forgeDevice;
  const paths = device?.settings?.paths;
  return device && paths ? { grant: { credentialId: device.credentialId, paths } } : {};
}
export const landElsewhere =
  'Nothing landed; the Lane keeps its work. Land it from your Forge browser or an unrestricted device, or move those files to another Lane.';
/** A grant landing's own files: the Candidate's trusted net change. Unknown files refuse (acceptance). */
export function requireLandingPaths(scope: readonly string[], paths: readonly string[] | null) {
  invariant(
    paths !== null,
    'AUTH_SCOPE_DENIED',
    `This landing came from a device limited to ${scope.join(', ')}, and its changed files are not known. ${landElsewhere}`,
  );
  const outside = paths.filter(path => !grantAllows(scope, path));
  invariant(
    outside.length === 0,
    'AUTH_SCOPE_DENIED',
    `This landing changes ${outside.slice(0, 5).join(', ')}${outside.length > 5 ? ` and ${outside.length - 5} more` : ''}, outside its device's folder grant (${scope.join(', ')}). ${landElsewhere}`,
  );
}

export function requireAccountWriteAccess(device?: Pick<Doc<'cliCredentials'>, 'settings'> | null) {
  const settings = device?.settings;
  invariant(
    !settings || (settings.projects.kind === 'all' && settings.source === 'write'),
    'AUTH_SCOPE_DENIED',
    'This device is limited to its selected projects or read-only access. Make account changes in your Forge browser.',
  );
}
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
