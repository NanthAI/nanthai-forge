// SPDX-License-Identifier: Apache-2.0
// Pure: runs in the CLI and in the Convex non-Node runtime.
import { z } from 'zod';

/** Private repositories a project's checks may read as submodules; the owner sets it. */
export const submoduleAllowLimit = 64;
const repositoryName = z
  .string()
  .regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/)
  .refine(name => name.split('/').every(part => part !== '.' && part !== '..'));
/** One allowed repository. `publicLogs`: the owner also accepts reading it when the
 * runner's check logs are public, where printed content becomes public too. */
export const submoduleAllowSchema = z
  .object({ repository: repositoryName, publicLogs: z.literal(true).optional() })
  .strict();
export type SubmoduleAllow = z.infer<typeof submoduleAllowSchema>;
export const submoduleAllowListSchema = z.array(submoduleAllowSchema).min(1).max(submoduleAllowLimit);
/** configure-runner input: merged into the current list. true allows the repository on
 * runners with private logs, "public-logs" also on runners with public logs, false removes it. */
export const submoduleAllowChangesSchema = z.record(
  repositoryName,
  z.union([z.literal(true), z.literal('public-logs'), z.literal(false)]),
);

const key = (name: string) => name.toLowerCase();

/** The stored list after a change: one entry per repository (GitHub names are
 * case-insensitive), sorted, so equal lists have equal digests. Undefined when empty. */
export function mergeSubmoduleAllowlist(
  current: readonly SubmoduleAllow[] | undefined,
  changes: Record<string, true | 'public-logs' | false>,
): SubmoduleAllow[] | undefined {
  const entries = new Map((current ?? []).map(entry => [key(entry.repository), entry]));
  for (const [repository, value] of Object.entries(changes)) {
    entries.delete(key(repository));
    if (value !== false)
      entries.set(key(repository), { repository, ...(value === 'public-logs' ? { publicLogs: true } : {}) });
  }
  const list = [...entries.values()].sort((a, b) => (key(a.repository) < key(b.repository) ? -1 : 1));
  return list.length ? submoduleAllowListSchema.parse(list) : undefined;
}

export type SubmoduleDecision = 'allowed' | 'not-allowed' | 'public-logs';
/** Refuse by default: only a listed repository, and on a runner with public check logs
 * only one the owner also allowed for public logs. */
export function submoduleDecision(
  allowlist: readonly SubmoduleAllow[] | undefined,
  repository: string,
  logsPublic: boolean,
): SubmoduleDecision {
  const entry = allowlist?.find(item => key(item.repository) === key(repository));
  if (!entry) return 'not-allowed';
  return logsPublic && !entry.publicLogs ? 'public-logs' : 'allowed';
}

/** The exact command the project owner runs to allow one repository. */
export const submoduleAllowCommand = (repository: string, publicLogs = false) =>
  `nforge agent ROOT configure-runner '${JSON.stringify({
    provider: 'github-actions',
    submodules: { [repository]: publicLogs ? 'public-logs' : true },
  })}'`;
