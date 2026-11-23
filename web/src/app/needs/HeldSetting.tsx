// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The held settings change under an open "Asked ahead" row (Item 16093ed1). One subscription (projectHostedApprovals:observe
// with detail, the approve page's read), mounted only while the row is open, so a closed or idle Needs me reads nothing
// more. It re-runs only on a write to that request or to the setting it changes.
import { useQuery } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import type { Id } from '../../../../convex/_generated/dataModel';
import { SettingChange } from '../../review/SettingChange';
import type { LaneApprovalRead } from '../../review/lane-approval-read';

const observe = makeFunctionReference<
  'query',
  { projectId: Id<'hostedProjects'>; laneId: string; detail: 1 },
  string
>('projectHostedApprovals:observe');

export function HeldSetting({ projectId, laneId }: { projectId: Id<'hostedProjects'>; laneId: string }) {
  const text = useQuery(observe, { projectId, laneId, detail: 1 });
  if (text === undefined)
    return (
      <div className="quietline" aria-busy="true">
        Reading the change…
      </div>
    );
  let read: LaneApprovalRead | null = null;
  try {
    read = JSON.parse(text) as LaneApprovalRead;
  } catch {
    read = null;
  }
  if (!read || read.change === undefined)
    return <div className="quietline">Only the project owner can read this change.</div>;
  return (
    <SettingChange
      origin={read.membership ? 'membership' : read.setting?.origin}
      compare={read.compare}
      change={read.change}
    />
  );
}
