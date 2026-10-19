// SPDX-License-Identifier: Apache-2.0
import { execFile } from 'node:child_process';
import { ForgeError } from './errors.js';

export type ActionsJob = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  run_attempt: number;
  steps?: { conclusion: string | null; number: number; name: string }[];
};
export type ActionsRun = {
  id: number;
  head_sha: string;
  display_title: string;
  status: string;
  conclusion: string | null;
  run_attempt: number;
};
export interface ActionsApi {
  request<T>(endpoint: string, method?: string, body?: unknown): Promise<T>;
  pages<T>(endpoint: string, key: string): Promise<T[]>;
  log(jobId: number, repo: string): Promise<string>;
  sleep(ms: number): Promise<void>;
  /** Milliseconds until the REST budget resets (`x-ratelimit-reset`), when known. */
  rateLimitResetMs?(): Promise<number | undefined>;
}
/** GitHub rejected the request for budget (primary/secondary limit). Nothing was performed. */
export const RATE_LIMITED = 'GITHUB_ACTIONS_RATE_LIMITED';
// gh prints GitHub's message on stderr; only the class is kept (stderr can carry account data).
const rateLimitText = /rate limit|HTTP 429|abuse detection/i;
function gh(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'gh',
      args,
      {
        env: { ...process.env, GH_PROMPT_DISABLED: '1' },
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) =>
        error
          ? reject(
              rateLimitText.test(String(stderr))
                ? new ForgeError(
                    RATE_LIMITED,
                    'GitHub API rate limit reached; waiting for the budget to reset.',
                  )
                : new ForgeError(
                    'GITHUB_ACTIONS_API',
                    'GitHub Actions request failed; retained operation requires reconciliation. Check gh authentication and API availability.',
                  ),
            )
          : resolve(stdout),
    );
    child.stdin?.end(input);
  });
}
export const actionsApi: ActionsApi = {
  async request<T>(endpoint: string, method = 'GET', body?: unknown) {
    const output = await gh(
      ['api', endpoint, '--method', method, ...(body === undefined ? [] : ['--input', '-'])],
      body === undefined ? undefined : JSON.stringify(body),
    );
    return (output.trim() ? JSON.parse(output) : undefined) as T;
  },
  async pages<T>(endpoint: string, key: string) {
    const pages = JSON.parse(await gh(['api', endpoint, '--paginate', '--slurp'])) as Record<string, T[]>[];
    return pages.flatMap(page => page[key] ?? []);
  },
  log: (id, repo) => gh(['api', `repos/${repo}/actions/jobs/${id}/logs`]),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  // The rate_limit endpoint does not count against the budget.
  async rateLimitResetMs() {
    try {
      const reset = Number(await gh(['api', 'rate_limit', '--jq', '.resources.core.reset']));
      return Number.isFinite(reset) ? reset * 1000 - Date.now() : undefined;
    } catch {
      return undefined;
    }
  },
};
const isRateLimited = (error: unknown) => (error as { code?: unknown })?.code === RATE_LIMITED;
/** Wait out a rate limit: until the reported reset (bounded to an hour), at least a minute. */
async function waitForBudget(api: ActionsApi, progress?: (message: string) => void) {
  const reset = await api.rateLimitResetMs?.();
  const ms = Math.min(3_600_000, Math.max(60_000, (reset ?? 0) + 1_000));
  progress?.(`GitHub API rate limited; waiting ${Math.round(ms / 1000)} s for the budget, then continuing.`);
  await api.sleep(ms);
}
/**
 * Read-only polling backs off on transport failures (bounded) and waits out rate limits without
 * giving up: a budget rejection says nothing about the check, so it never interrupts it.
 */
export async function observe<T>(
  api: ActionsApi,
  read: () => Promise<T>,
  progress?: (message: string) => void,
): Promise<T> {
  for (let attempt = 0; ;) {
    try {
      return await read();
    } catch (error) {
      if (isRateLimited(error)) {
        await waitForBudget(api, progress);
        continue;
      }
      if (attempt === 5) throw error;
      await api.sleep(Math.min(60_000, 5_000 * 2 ** attempt++));
    }
  }
}
/** Mutations retry only a rate-limit rejection: GitHub performed nothing, so the outcome is known. */
export async function mutate<T>(
  api: ActionsApi,
  write: () => Promise<T>,
  progress?: (message: string) => void,
): Promise<T> {
  for (;;) {
    try {
      return await write();
    } catch (error) {
      if (!isRateLimited(error)) throw error;
      await waitForBudget(api, progress);
    }
  }
}
