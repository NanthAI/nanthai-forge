// SPDX-License-Identifier: Apache-2.0
import type { SettingCompare } from './setting-change';

/** One Lane's approval request as projectHostedApprovals:observe {detail:1} returns it. */
export type LaneApprovalRead = {
  laneId: string;
  status: 'none' | 'requested' | 'granted' | 'declined';
  live: boolean;
  reason?: string;
  /** A Forge handle, or absent when the viewer may not see people. */
  requester?: string;
  agent?: string;
  head?: string;
  currentHead?: string;
  decision?: { by?: string; head: string; reason?: string; via: 'lane' | 'landing' };
  /** A fork pull request's run request (Issue f7793473): granting runs its check, never lands. */
  pullRequest?: number;
  ended?: { kind: 'landed' | 'withdrawn' | 'settled' | 'applied' };
  landing: { submissionId: string; held: boolean } | null;
  /** Issue 470ef29b: a held settings change from an agent sign-in, not a Lane. */
  membership?: boolean;
  setting?: {
    origin:
      | 'policy'
      | 'check-definition'
      | 'check-import'
      | 'runner'
      | 'main-audit'
      | 'address'
      | 'github-connect';
  };
  /** The change as the agent sent it (the owner's read only). */
  change?: unknown;
  /** Item 16093ed1: the setting now and as granted (an open request, the owner's read only). */
  compare?: SettingCompare | null;
};
