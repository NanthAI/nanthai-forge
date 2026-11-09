// SPDX-License-Identifier: Apache-2.0
/**
 * What an owner approval request is and where it stands (SM-D, machine M3). One table holds three
 * kinds of request: a Lane approval (holds that Lane's landings), a fork pull request run request
 * and a held settings change. The stored `live` flag only means "holds a landing"; whether a request
 * is still open is derived here, once, for the server read models, the web and the CLI.
 *
 * Pure: reads the fields `approvalView` already returns, so it adds no Convex call or read.
 */
export type ApprovalKind = 'lane' | 'fork' | 'setting';
export type ApprovalPhase =
  | 'requested'
  | 'granted'
  | 'declined'
  | 'landed'
  | 'withdrawn'
  | 'settled'
  | 'applied'
  /** A row whose recorded fields fit no known request: never counted as open or closed. */
  | 'unknown';
export type ApprovalTone = 'waiting' | 'passed' | 'failed' | 'plain';

export type ApprovalRecord = {
  status: string;
  live: boolean;
  pullRequest?: number | undefined;
  setting?: unknown;
  ended?: { kind: string } | undefined;
};

export type ApprovalState = {
  kind: ApprovalKind;
  state: ApprovalPhase;
  /** Still a live request: a Lane request that holds landings, or a fork or settings request not yet ended. */
  open: boolean;
  /** Open and undecided: this is the owner's to answer. */
  needsOwner: boolean;
  label: string;
  tone: ApprovalTone;
  nextStep: string;
};

const kinds = {
  lane: 'Lane approval',
  fork: 'Fork pull request run',
  setting: 'Held settings change',
} as const;
const endedPhases = {
  landed: 'landed',
  withdrawn: 'withdrawn',
  settled: 'settled',
  applied: 'applied',
} as const satisfies Record<string, ApprovalPhase>;
const statusPhases = {
  requested: 'requested',
  granted: 'granted',
  declined: 'declined',
} as const satisfies Record<string, ApprovalPhase>;
const has = <T extends object>(table: T, key: string): key is Extract<keyof T, string> =>
  Object.prototype.hasOwnProperty.call(table, key);

export const approvalKind = (record: Pick<ApprovalRecord, 'pullRequest' | 'setting'>): ApprovalKind =>
  record.setting !== undefined ? 'setting' : record.pullRequest !== undefined ? 'fork' : 'lane';

const words = {
  requested: (kind: ApprovalKind) => ({
    label: `${kinds[kind]} waits for you`,
    tone: 'waiting' as const,
    nextStep:
      kind === 'setting'
        ? 'Open the approve link, then grant or decline the settings change.'
        : kind === 'fork'
          ? 'Open the approve link, then grant or decline the check run for this pull request.'
          : 'Open the approve link, then grant or decline; a grant lets the Lane land.',
  }),
  granted: (kind: ApprovalKind) => ({
    label: `${kinds[kind]} granted`,
    tone: 'passed' as const,
    nextStep: kind === 'lane' ? 'Nothing to do; the Lane can land.' : 'Nothing to do; it is being applied.',
  }),
  declined: (kind: ApprovalKind) => ({
    label: `${kinds[kind]} declined`,
    tone: 'failed' as const,
    nextStep:
      kind === 'lane'
        ? 'The builder addresses it and asks again; or grant it from the approve link.'
        : 'Grant it from the approve link, or leave it declined.',
  }),
  landed: (kind: ApprovalKind) => ({
    label: `${kinds[kind]} landed`,
    tone: 'passed' as const,
    nextStep: 'Nothing to do.',
  }),
  withdrawn: (kind: ApprovalKind) => ({
    label: `${kinds[kind]} withdrawn`,
    tone: 'plain' as const,
    nextStep: 'Nothing to do.',
  }),
  settled: (kind: ApprovalKind) => ({
    label: `${kinds[kind]} closed`,
    tone: 'plain' as const,
    nextStep: 'Nothing to do.',
  }),
  applied: (kind: ApprovalKind) => ({
    label: `${kinds[kind]} applied`,
    tone: 'passed' as const,
    nextStep: 'Nothing to do.',
  }),
  unknown: (kind: ApprovalKind) => ({
    label: `${kinds[kind]}: can't confirm its state`,
    tone: 'waiting' as const,
    nextStep: 'Refresh; if it persists, open the approve link to read the request.',
  }),
} satisfies Record<
  ApprovalPhase,
  (kind: ApprovalKind) => { label: string; tone: ApprovalTone; nextStep: string }
>;

/**
 * Branch order, the same for the approval pages, Needs you and `wait {approval}`: a decision outranks how
 * the request ended (a granted request that then landed or was applied says so; a granted fork run
 * request whose head later settled is still Granted, and a declined one is still Declined). Only an
 * undecided request is named by how it ended.
 */
export function deriveApproval(record: ApprovalRecord): ApprovalState {
  const kind = approvalKind(record);
  const decided = record.status === 'granted' || record.status === 'declined';
  const state: ApprovalPhase = decided
    ? record.ended && !has(endedPhases, record.ended.kind)
      ? 'unknown'
      : record.ended?.kind === 'landed' || record.ended?.kind === 'applied'
        ? endedPhases[record.ended.kind]
        : statusPhases[record.status as 'granted' | 'declined']
    : record.ended
      ? has(endedPhases, record.ended.kind)
        ? endedPhases[record.ended.kind]
        : 'unknown'
      : has(statusPhases, record.status)
        ? // A Lane request that holds no landing and is not ended fits no writer: do not call it open.
          kind === 'lane' && !record.live
          ? 'unknown'
          : statusPhases[record.status]
        : 'unknown';
  const open = !record.ended && state !== 'unknown';
  return {
    kind,
    state,
    open,
    needsOwner: open && state === 'requested',
    ...words[state](kind),
  };
}

/**
 * What `wait {approval}` does with an observed request: a decision settles `decided` (the same decision
 * branch as `deriveApproval`), a request nothing will decide (none, or closed without a decision)
 * settles `none`, and an open one keeps waiting. `live` is absent on older reads; only false closes it.
 */
export function approvalWait(record: { status: string; live?: boolean | undefined }) {
  return record.status === 'granted' || record.status === 'declined'
    ? ('decided' as const)
    : record.status === 'none' || record.live === false
      ? ('none' as const)
      : ('waiting' as const);
}
