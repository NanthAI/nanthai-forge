// SPDX-License-Identifier: Apache-2.0
/** C1 provisional policies. Owner-confirmation stays open on df06081d/76e3ae31.
 * Each disputed rule has one setting; consumers call the policy rather than copy it. */
export const accessPolicy = {
  laneTakeover: 'same-person-or-project-owner' as 'same-person-or-project-owner' | 'project-writers',
  liveTakeoverReason: true,
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
