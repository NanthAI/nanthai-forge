// SPDX-License-Identifier: Apache-2.0
export type CheckHeader = { id: string; name: string };
export type CheckRun = { id: string; checkId: string; status: string; startedAt: string; endedAt?: string };
export type AcceptanceEvidence = {
  at?: string;
  channel?: string;
  status?: string;
  automatic?: { runId?: string };
  invariant?: { currentPolicy?: boolean; policy: { checkIds: string[] } };
};
export function acceptanceChecks(moves: AcceptanceEvidence[], runs: CheckRun[]) {
  const byId = new Map(runs.map(run => [run.id, run.checkId]));
  const latest = moves
    .filter(move => (!move.channel || move.channel === 'main') && move.status !== 'pending')
    .reduce<AcceptanceEvidence | undefined>(
      (previous, move) => (!previous || (move.at ?? '') > (previous.at ?? '') ? move : previous),
      undefined,
    );
  if (!latest) return new Set<string>();
  return new Set([
    ...(latest.invariant?.currentPolicy ? latest.invariant.policy.checkIds : []),
    ...(latest.automatic?.runId && byId.has(latest.automatic.runId)
      ? [byId.get(latest.automatic.runId)!]
      : []),
  ]);
}
export function checksModel<T extends CheckHeader>(
  checks: T[],
  runs: CheckRun[],
  required: ReadonlySet<string>,
  now: number,
  query = '',
) {
  const latest = new Map<string, CheckRun>(),
    counts = new Map<string, number>();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  for (const run of runs) {
    counts.set(run.checkId, (counts.get(run.checkId) ?? 0) + 1);
    if (!latest.has(run.checkId) || run.startedAt > latest.get(run.checkId)!.startedAt)
      latest.set(run.checkId, run);
  }
  const sorted = checks
    .filter(check => check.name.toLowerCase().includes(query.toLowerCase()))
    .sort(
      (a, b) =>
        Number(required.has(b.id)) - Number(required.has(a.id)) ||
        (latest.get(b.id)?.startedAt ?? '').localeCompare(latest.get(a.id)?.startedAt ?? '') ||
        a.name.localeCompare(b.name),
    );
  const recent = (check: T) =>
    required.has(check.id) || Date.parse(latest.get(check.id)?.startedAt ?? '') >= now - 7 * 86400000;
  const daily = runs.filter(run => Date.parse(run.startedAt) >= today.getTime());
  return {
    active: sorted.filter(recent),
    older: sorted.filter(check => !recent(check)),
    latest,
    counts,
    today: daily.length,
    failed: daily.filter(run => run.status === 'failed').length,
  };
}
/** Presentation only: retain the original command in title, never execute or rewrite it. */
export function checkCommand(executable: string, args: string[], projectNames: string[] = []) {
  const names = projectNames.filter(Boolean).map(name =>
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, ''),
  );
  const path = (value: string) => {
    if (!value.startsWith('/') && !/^[A-Z]:[\\/]/i.test(value)) return value;
    const parts = value.replaceAll('\\', '/').split('/');
    const workspace = parts.findIndex(
      (part, index) => part === 'workspace' && parts.slice(0, index).includes('.forge'),
    );
    const laneRoot = parts.findIndex(
      (part, index) =>
        part.startsWith('lane-') && parts[index - 1] === 'work' && parts[index - 2] === '.forge',
    );
    const repo = parts.reduce(
      (found, part, index) => (names.includes(part.toLowerCase()) ? index : found),
      -1,
    );
    if (workspace >= 0 || repo >= 0 || laneRoot >= 0)
      return parts.slice(Math.max(workspace, repo, laneRoot) + 1).join('/');
    const home = value.replace(/^\/(?:Users|home)\/[^/]+\//, '~/');
    return home.startsWith('~/') && home.length <= 48 ? home : `~/…/${parts.at(-1)}`;
  };
  const runtime = executable.replaceAll('\\', '/').split('/').at(-1)!;
  const command = ['node', 'node.exe', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'python', 'python3'].includes(
    runtime,
  )
    ? runtime
    : path(executable);
  return [
    command,
    ...args.map(arg =>
      arg.replace(
        /(^|[=\s'"])((?:[A-Z]:[\\/]|\/)[^\s'"`]+)/gi,
        (_match, prefix: string, value: string) => prefix + path(value),
      ),
    ),
  ].join(' ');
}
