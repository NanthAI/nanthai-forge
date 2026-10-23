// SPDX-License-Identifier: Apache-2.0
import { execFile } from 'node:child_process';
import { ForgeError } from './errors.js';
import { redactGitStderr } from './github-sync-git.js';

export type ActionsJob = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  run_attempt: number;
  started_at?: string | null;
  completed_at?: string | null;
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
export type ActionsFailure = { status?: number; message?: string; documentation_url?: string };
/** Retain only GitHub's structured response fields; never retain gh stderr or response headers. */
export function actionsFailure(body: unknown, status?: number): ActionsFailure {
  const value = (Array.isArray(body) ? body.at(-1) : body) as {
    message?: unknown;
    documentation_url?: unknown;
  } | null;
  const message =
    typeof value?.message === 'string'
      ? redactGitStderr(value.message, value.message.length)
          .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]+\b/g, '[account]')
          .replace(/\b(user|account|installation) ID[ :#]+[\w-]+/gi, '$1 ID [account]')
          .replace(/\b(user|account) ["'][^"']+["']/gi, '$1 [account]')
          .replace(/https:\/\/(?:api\.)?github\.com\/[^\s)]+/gi, '[GitHub URL]')
      : undefined;
  const url = typeof value?.documentation_url === 'string' ? value.documentation_url : undefined;
  return {
    ...(status === undefined ? {} : { status }),
    ...(message ? { message } : {}),
    ...(url && /^https:\/\/docs\.github\.com\/[^\s?]*$/.test(url) ? { documentation_url: url } : {}),
  };
}
export function actionsFailureText(failure?: ActionsFailure) {
  return `${failure?.message ? ` GitHub: ${failure.message}` : ''}${failure?.documentation_url ? ` (${failure.documentation_url})` : ''}`;
}
export class ActionsApiError extends ForgeError {
  readonly outcome: 'rejected' | 'ambiguous';
  readonly response: ActionsFailure;
  readonly rejectionClass: 'not-found' | 'unprocessable' | 'rate-limited' | undefined;
  constructor(
    readonly httpStatus?: number,
    body?: unknown,
    rateLimited = false,
  ) {
    const outcome = httpStatus === 404 || httpStatus === 422 ? 'rejected' : 'ambiguous';
    const response = actionsFailure(body, httpStatus);
    super(
      rateLimited ? RATE_LIMITED : 'GITHUB_ACTIONS_API',
      `GitHub Actions request ${outcome}${httpStatus === undefined ? '' : ` (HTTP ${httpStatus})`}; retained operation requires reconciliation.${actionsFailureText(response)}`,
    );
    this.rejectionClass = rateLimited
      ? 'rate-limited'
      : httpStatus === 404
        ? 'not-found'
        : httpStatus === 422
          ? 'unprocessable'
          : undefined;
    this.outcome = outcome;
    this.response = response;
  }
}
// Rate-limit detection retains the existing primary/secondary-budget handling.
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
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        const status = /\bHTTP(?:\/\d(?:\.\d)?)?\s+(\d{3})\b/i.exec(String(stderr))?.[1];
        const httpStatus = status === undefined ? undefined : Number(status);
        let body: unknown;
        try {
          body = JSON.parse(stdout);
        } catch {
          /* Non-JSON output is not safe diagnostic data. */
        }
        reject(
          new ActionsApiError(
            httpStatus,
            body,
            httpStatus === 429 || (httpStatus === 403 && rateLimitText.test(String(stderr))),
          ),
        );
      },
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
/** Records even transient/swallowed failures before the controller retries or continues. */
export function recordActionsFailures(api: ActionsApi, record: (error: ActionsApiError) => void): ActionsApi {
  const attempt = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      if (error instanceof ActionsApiError) record(error);
      throw error;
    }
  };
  return {
    request: <T>(...args: Parameters<ActionsApi['request']>) => attempt(() => api.request<T>(...args)),
    pages: <T>(...args: Parameters<ActionsApi['pages']>) => attempt(() => api.pages<T>(...args)),
    log: (...args) => attempt(() => api.log(...args)),
    sleep: ms => api.sleep(ms),
    rateLimitResetMs: () => api.rateLimitResetMs?.() ?? Promise.resolve(undefined),
  };
}
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
