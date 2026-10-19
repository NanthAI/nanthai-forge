// SPDX-License-Identifier: Apache-2.0
import { Icon, type IconName } from './Icons';
const states: Record<string, { label: string; tone: string; icon: IconName }> = {
  working: { label: 'Reported working', tone: 'info', icon: 'activity' },
  waiting: { label: 'Reported waiting', tone: 'warning', icon: 'clock' },
  observing: { label: 'Reported observing', tone: 'muted', icon: 'review' },
  active: { label: 'Open', tone: 'info', icon: 'activity' },
  open: { label: 'Open', tone: 'info', icon: 'activity' },
  'in-progress': { label: 'In progress', tone: 'info', icon: 'activity' },
  ready: { label: 'Ready for review', tone: 'review', icon: 'review' },
  completed: { label: 'Completed', tone: 'success', icon: 'check' },
  closed: { label: 'Closed', tone: 'muted', icon: 'check' },
  passed: { label: 'Passed', tone: 'success', icon: 'check' },
  failed: { label: 'Failed', tone: 'danger', icon: 'close' },
  conflict: { label: 'Conflicts', tone: 'danger', icon: 'alert' },
  revoked: { label: 'Revoked', tone: 'danger', icon: 'close' },
  expired: { label: 'Expired', tone: 'muted', icon: 'clock' },
  abandoned: { label: 'Abandoned', tone: 'muted', icon: 'close' },
  paused: { label: 'Paused', tone: 'warning', icon: 'pause' },
  running: { label: 'Running', tone: 'info', icon: 'activity' },
  queued: { label: 'Queued', tone: 'muted', icon: 'clock' },
  clean: { label: 'Clean composition', tone: 'success', icon: 'check' },
  granted: { label: 'Access granted', tone: 'success', icon: 'check' },
  interrupted: { label: 'Interrupted', tone: 'muted', icon: 'close' },
  preparing: { label: 'Preparing', tone: 'info', icon: 'activity' },
  cancelled: { label: 'Cancelled', tone: 'muted', icon: 'close' },
};
export function WorkStatus({ status, label }: { status: string; label?: string }) {
  const state = states[status] ?? { label: status, tone: 'muted', icon: 'clock' as const };
  return (
    <span className={`work-status tone-${state.tone}`}>
      <Icon name={state.icon} />
      {label ?? state.label}
    </span>
  );
}
