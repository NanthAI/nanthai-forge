// SPDX-License-Identifier: Apache-2.0
/** Observations compare source pins, never elapsed time or presence silence. */
export type HostedFreshness = {
  syncedAt: number | null;
  sourceRevision: number;
  mainHead: string | null;
  machine: { name: string; reportedAt: number; mainHead: string | null } | null;
  ownerReport: { reportedAt: number; revision: number } | null;
  push: { startedAt: number; pending: string } | null;
};
export function hostedFreshness(value?: HostedFreshness | null) {
  const newerWork = !!value?.ownerReport && value.ownerReport.revision > value.sourceRevision;
  const newerMain =
    !!value?.machine?.mainHead &&
    value.mainHead !== value.machine.mainHead &&
    (value.syncedAt === null || value.machine.reportedAt > value.syncedAt);
  return { behind: newerWork || newerMain || !!value?.push, catchingUp: !!value?.push };
}
export function asOf(value?: HostedFreshness | null) {
  return value?.syncedAt == null
    ? 'as of the last hosted sync (time unknown)'
    : `as of ${new Date(value.syncedAt).toISOString()}`;
}
