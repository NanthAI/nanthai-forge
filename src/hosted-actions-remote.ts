// SPDX-License-Identifier: Apache-2.0
import { ActionsApiError, type ActionsApi } from './github-actions-api.js';
import { actionsAccessMessage, type HostedActionsMapping } from './hosted-actions.js';
import type { HostedCheckRun } from './hosted-check.js';
import type { SourceWorkerTransport } from './hosted-source-worker-reader.js';
import { withHostedActionsExport } from './hosted-actions-export.js';
import { hostedActionsGit } from './hosted-actions-git.js';
import { ForgeError, invariant } from './errors.js';

type Configuration = Extract<HostedCheckRun['configuration'], { provider: 'github-actions' }>;
/** Existing credential-use boundary supplies an installation token privately.
 * It must resolve this version/reference for this installation and repository.
 * No registration, account discovery, personal-token or gh fallback is provided. */
export type ActionsCredentialUse = <T>(
  reference: Configuration['credential'],
  installationId: string,
  repository: string,
  use: (installationToken: string) => Promise<T>,
) => Promise<T>;
export class HostedActionsAccessError extends ForgeError {
  constructor(readonly reason: 'registration' | 'access') {
    super(
      reason === 'registration' ? 'GITHUB_APP_UNAVAILABLE' : 'GITHUB_APP_ACCESS',
      actionsAccessMessage(reason),
    );
  }
}
export interface HostedActionsRemote {
  api: Pick<ActionsApi, 'request' | 'pages'>;
  publish(mapping: HostedActionsMapping): Promise<void>;
  delete(mapping: HostedActionsMapping): Promise<void>;
}
export function hostedActionsRemote(
  configuration: Configuration,
  credentials: ActionsCredentialUse,
  transport: (mapping: HostedActionsMapping) => SourceWorkerTransport,
  request: typeof fetch = fetch,
  runGit = hostedActionsGit,
): HostedActionsRemote {
  const use = <T>(operation: (token: string) => Promise<T>) =>
    credentials(
      configuration.credential,
      configuration.installationId,
      configuration.repository,
      async token => {
        if (!token) throw new HostedActionsAccessError('registration');
        return operation(token);
      },
    );
  const call = async (endpoint: string, method = 'GET', body?: unknown) => {
    invariant(
      endpoint.startsWith(`repos/${configuration.repository}/`) &&
        !endpoint.includes('..') &&
        !endpoint.includes('#'),
      'EVIDENCE_CHANGED',
      'Use only the configured Actions repository route.',
    );
    try {
      return await use(async token => {
        let response: Response;
        try {
          response = await request(`https://api.github.com/${endpoint}`, {
            method,
            redirect: 'error',
            signal: AbortSignal.timeout(20_000),
            headers: {
              authorization: `Bearer ${token}`,
              accept: 'application/vnd.github+json',
              'x-github-api-version': '2022-11-28',
              ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
        } catch {
          throw new ActionsApiError();
        }
        if ([401, 403].includes(response.status)) throw new HostedActionsAccessError('access');
        if (!response.ok) throw new ActionsApiError(response.status);
        return response;
      });
    } catch (error) {
      if (error instanceof ActionsApiError || error instanceof HostedActionsAccessError) throw error;
      throw new HostedActionsAccessError('registration');
    }
  };
  const api: HostedActionsRemote['api'] = {
    async request<T>(endpoint: string, method = 'GET', body?: unknown) {
      const response = await call(endpoint, method, body);
      // Dispatch's 204 carries no JSON. Never read account/error response bodies.
      try {
        return (response.status === 204 ? undefined : await response.json()) as T;
      } catch {
        throw new ActionsApiError();
      }
    },
    async pages<T>(endpoint: string, key: string) {
      const values: T[] = [],
        until = Date.now() + 60_000;
      for (let page = 1; ; page++) {
        if (Date.now() >= until) throw new ActionsApiError();
        const response = await call(`${endpoint}${endpoint.includes('?') ? '&' : '?'}page=${page}`);
        let value: Record<string, T[]>;
        try {
          value = (await response.json()) as Record<string, T[]>;
        } catch {
          throw new ActionsApiError();
        }
        invariant(
          Array.isArray(value[key]),
          'GITHUB_ACTIONS_UNKNOWN',
          'Actions lookup response is incomplete.',
        );
        values.push(...value[key]!);
        if (!response.headers.get('link')?.includes('rel="next"')) return values;
      }
    },
  };
  const refOperation = async (m: HostedActionsMapping, remove: boolean) => {
    invariant(
      m.repository === configuration.repository && m.export,
      'EVIDENCE_CHANGED',
      'Use the retained Actions repository and export.',
    );
    const exported = m.export;
    // Resolve access before Git I/O so missing installation permissions are actionable.
    try {
      await api.request(`repos/${configuration.repository}/actions/workflows?per_page=1`);
    } catch (error) {
      if (error instanceof ActionsApiError && error.httpStatus === 404)
        throw new HostedActionsAccessError('access');
      throw error;
    }
    return withHostedActionsExport(exported, transport(m), root =>
      use(async token => {
        const git = (args: string[]) => runGit(root, args, undefined, token);
        const ref = `refs/heads/${m.branch}`,
          remote = `https://github.com/${configuration.repository}.git`;
        const observed = await git(['ls-remote', '--refs', remote, ref]);
        if (observed)
          invariant(
            observed === `${exported.commit}\t${ref}`,
            'EVIDENCE_CHANGED',
            'Actions run-owned ref names different source; preserve it.',
          );
        if (remove) {
          if (observed)
            await git(['push', `--force-with-lease=${ref}:${exported.commit}`, remote, `:${ref}`]);
        } else if (!observed)
          await git(['push', `--force-with-lease=${ref}:`, remote, `${exported.commit}:${ref}`]);
      }),
    );
  };
  return { api, publish: m => refOperation(m, false), delete: m => refOperation(m, true) };
}
