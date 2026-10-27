// SPDX-License-Identifier: Apache-2.0
export function syncSummary(
  result: { status?: string; changedPaths?: unknown[]; conflicts?: unknown[] },
  channel: string,
) {
  if (result.status === 'up-to-date') return `up-to-date with ${channel}`;
  const count =
    result.status === 'conflict'
      ? (result.conflicts?.length ?? result.changedPaths?.length ?? 0)
      : (result.changedPaths?.length ?? 0);
  return result.status === 'conflict'
    ? `conflicts in ${count} ${count === 1 ? 'file' : 'files'} from ${channel}`
    : `merged ${count} ${count === 1 ? 'file' : 'files'} from ${channel}`;
}
