// SPDX-License-Identifier: Apache-2.0
// Counts the GitHub REST requests one source import makes, by who pays for them,
// and keeps the importer's own credential to a small share of their hourly limit.
// No token is stored: requests are classified by the credential's public prefix.
import { ForgeError } from './errors.js';

/** Who a request's rate limit belongs to. `user`: the importer's own GitHub
 * credential (shares their personal limit with gh and every other tool).
 * `app`: the Forge GitHub App (installation token, App JWT or App client
 * credentials; a separate quota). `server`: the deployment's own configured
 * token. `anonymous`: no credential (the deployment's shared IP limit). */
export type ImportTokenClass = 'user' | 'app' | 'server' | 'anonymous';
export type ImportGithubRequests = Record<ImportTokenClass, number> & {
  /** The importer's current GitHub rate window as GitHub reported it, and how
   * many of its requests this import has used. */
  userWindow?: { reset: number; used: number; limit: number };
};
/** Owner decision (Issue 2ccd3bae): an import may use about 10 percent of the
 * importer's hourly limit; App installation tokens carry the rest. */
export const importUserQuotaShare = 0.1;
/** GitHub's documented authenticated limit, used until a response reports one. */
const defaultUserLimit = 5000;

export function tokenClass(authorization: string | null | undefined): ImportTokenClass {
  if (!authorization) return 'anonymous';
  if (/^basic /i.test(authorization)) return 'app';
  const token = authorization.replace(/^(bearer|token) /i, '');
  if (/^gh[uo]_/.test(token)) return 'user';
  // Installation tokens are ghs_; an App JWT is three base64url parts.
  if (/^ghs_/.test(token) || /^eyJ[\w-]*\.[\w-]+\.[\w-]+$/.test(token)) return 'app';
  return 'server';
}
function authorizationOf(init: RequestInit | undefined): string | null {
  const headers = init?.headers;
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get('authorization');
  if (Array.isArray(headers))
    return headers.find(([name]) => name.toLowerCase() === 'authorization')?.[1] ?? null;
  for (const [name, value] of Object.entries(headers))
    if (name.toLowerCase() === 'authorization') return value;
  return null;
}
const isGithubApi = (input: unknown) => {
  try {
    return new URL(input instanceof Request ? input.url : String(input)).hostname === 'api.github.com';
  } catch {
    return false;
  }
};

export const emptyImportRequests = (): ImportGithubRequests => ({ user: 0, app: 0, server: 0, anonymous: 0 });

/** One meter per worker run, seeded from the job's saved counters. `wrap`
 * returns a fetch that counts api.github.com requests and refuses a user-token
 * request once this import has used its share of the importer's current window. */
export class ImportRequestMeter {
  readonly counts: ImportGithubRequests;
  constructor(
    prior: ImportGithubRequests | undefined,
    private readonly now: () => number = Date.now,
  ) {
    this.counts = { ...emptyImportRequests(), ...structuredClone(prior ?? {}) };
  }
  /** The importer's share of their hourly GitHub limit. */
  static cap(limit: number) {
    return Math.max(1, Math.floor(limit * importUserQuotaShare));
  }
  private refuseOverCap() {
    const window = this.counts.userWindow;
    if (!window || this.now() >= window.reset * 1000) return;
    const cap = ImportRequestMeter.cap(window.limit);
    if (window.used < cap) return;
    const at = window.reset * 1000;
    throw new ForgeError(
      'GITHUB_RATE_LIMIT',
      `This import used its share of your GitHub API limit (${cap} of ${window.limit} requests this hour). Retry after ${new Date(at).toISOString()}; your remaining quota stays free for your own tools.`,
      at,
    );
  }
  private recordUser(response: Response) {
    const limit = Number(response.headers.get('x-ratelimit-limit')),
      reset = Number(response.headers.get('x-ratelimit-reset'));
    const previous = this.counts.userWindow;
    const known = Number.isSafeInteger(reset) && reset > 0;
    const windowReset = known
      ? reset
      : previous && this.now() < previous.reset * 1000
        ? previous.reset
        : Math.ceil(this.now() / 1000) + 3600;
    const windowLimit =
      Number.isSafeInteger(limit) && limit > 0 ? limit : (previous?.limit ?? defaultUserLimit);
    this.counts.userWindow =
      previous && previous.reset === windowReset
        ? { reset: windowReset, used: previous.used + 1, limit: windowLimit }
        : { reset: windowReset, used: 1, limit: windowLimit };
  }
  wrap(base: typeof fetch): typeof fetch {
    return async (input, init) => {
      if (!isGithubApi(input)) return base(input, init);
      const kind = tokenClass(authorizationOf(init));
      if (kind === 'user') this.refuseOverCap();
      this.counts[kind]++;
      const response = await base(input, init);
      if (kind === 'user') this.recordUser(response);
      return response;
    };
  }
}
