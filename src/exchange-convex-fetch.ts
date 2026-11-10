// SPDX-License-Identifier: Apache-2.0
import { indexProgressReporter } from './work-index-client.js';
import { exchangeFetch, type ExchangeRequestOptions } from './exchange-request.js';
import { ForgeError } from './errors.js';
import { LONG_ACTION_DEADLINE_MS, pendingProgressGuard, longConvexAction } from './long-action.js';
import type { Dispatcher } from 'undici';

// Node fetch otherwise inherits Undici's five-minute header deadline. Override
// the dispatched request as well as our AbortController deadline. Undici is a large module
// graph that only a long action needs, so it loads on the first one (not at every CLI start).
let actionDispatcher: Promise<Dispatcher> | undefined;
const longActionDispatcher = () =>
  (actionDispatcher ??= import('undici').then(({ Agent }) => {
    class LongActionAgent extends Agent {
      override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) {
        return super.dispatch({ ...options, headersTimeout: LONG_ACTION_DEADLINE_MS }, handler);
      }
    }
    return new LongActionAgent();
  }));

// Reads, content-addressed commits, and pinned publication pages are replay-safe.
const replaySafe = new Set([
  'agentActions:describe',
  'agentActions:read',
  'projectMain:current',
  'projectHostedChannels:current',
  'projectHostedAgent:capabilities',
  'projectHostedLanes:select',
  'projectHostedOverlaps:read',
  'projectMain:objects',
  'projectObjects:missing',
  'projectObjects:available',
  'projectWork:state',
  'projectObjectDownloads:describe',
  'projectObjectDownloads:lanePage',
  'projectObjects:prepareBatch',
  'projectObjectDownloads:signDownloads',
  'projectObjectCommit:commitBatch',
  'projectObjectRecipes:complete',
  'projectExchangeActions:checkpoint',
  'projectExchangeActions:downloadBatch',
  'projectExchangeActions:downloadPart',
  'projectProposalObjects:checkpoint',
  'projectWorkActions:exportJournal',
  'projectWorkIndexActions:ensure',
]);
export { longConvexAction } from './long-action.js';
const receiptCalls = new Set(['projectExchangeMigration:migrate']);

/** The HTTP client uses this for every exchange query, mutation and action,
 * including direct calls from bound exchange and the upload/transport helpers. */
export function exchangeConvexFetch(
  options: ExchangeRequestOptions = {},
  onCall?: (name: string, pending: boolean) => void,
  signal?: AbortSignal,
): typeof fetch {
  return async (url, init) => {
    const payload = typeof init?.body === 'string' ? JSON.parse(init.body) : {},
      name = typeof payload.path === 'string' ? payload.path : 'exchange Convex request',
      safe =
        String(url).endsWith('/api/query') ||
        String(url).endsWith('/api/query_at_ts') ||
        replaySafe.has(name) ||
        replayableOperation(name, payload.args?.[0]) ||
        (receiptCalls.has(name) && typeof payload.args?.[0]?.operationId === 'string'),
      longAction = String(url).endsWith('/api/action') && longConvexAction(name);
    const continuable = longAction && name === 'projectWorkIndexActions:ensure';
    const guard = pendingProgressGuard(name, payload.args?.[0]?.operationId ?? name);
    let progressName: string | undefined;
    const indexProgress = name === 'projectWorkIndexActions:ensure' ? indexProgressReporter() : undefined;
    onCall?.(name, true);
    try {
      const request: RequestInit & { dispatcher?: Dispatcher } = {
        ...init,
        // Preserve caller/native redirect behavior; the shared deadline owns
        // the complete chain rather than silently adding a route restriction.
        ...(signal ? { signal } : {}),
        ...(longAction ? { dispatcher: await longActionDispatcher() } : {}),
      };
      while (true) {
        if (continuable) request.body = JSON.stringify(payload);
        const response = await exchangeFetch(name, url, request, {
          // Actions may rebuild retained Work before sending any response bytes.
          ...(longAction
            ? { headerTimeoutMs: LONG_ACTION_DEADLINE_MS, totalTimeoutMs: LONG_ACTION_DEADLINE_MS }
            : {}),
          ...options,
          retries: safe ? (options.retries ?? 3) : 0,
        });
        if (response.status === 429 || (response.status >= 500 && response.status !== 560))
          throw unavailable(name, response);
        if (continuable && response.ok) {
          const envelope = await response
            .clone()
            .json()
            .catch(() => null);
          const value = envelope?.status === 'success' ? envelope.value : null;
          if (value?.pending === true) {
            guard(value.progress);
            if (value.progress) indexProgress?.(value.progress);
            payload.args[0].continuation = true;
            if (progressName) onCall?.(progressName, false);
            progressName = `${name}: ${value.progress ?? 'pending'}`;
            onCall?.(progressName, true);
            await new Promise(resolve => setTimeout(resolve, 0));
            continue;
          }
        }
        return response;
      }
    } finally {
      if (progressName) onCall?.(progressName, false);
      onCall?.(name, false);
    }
  };
}

/** The SDK drops the status and Retry-After of a refused request; keep both so
 * the CLI says when to retry and waits instead of retrying at once (72d50375).
 * 429/503 refused the request; other 5xx may have run it, so its outcome stays
 * unknown until the same operation is replayed. */
function unavailable(name: string, response: Response) {
  void response.body?.cancel().catch(() => {});
  const seconds = Number(response.headers.get('retry-after'));
  const refused = response.status === 429 || response.status === 503;
  return new ForgeError(
    'EXCHANGE_REQUEST_FAILED',
    `${name} returned HTTP ${response.status} after bounded retries. Retry the original operation to reconcile its outcome.`,
    Number.isFinite(seconds) && seconds > 0 ? Date.now() + Math.min(seconds, 15 * 60) * 1000 : undefined,
    { httpStatus: response.status, outcome: refused ? 'refused' : 'unknown' },
  );
}

function replayableOperation(name: string, args: Record<string, unknown> | undefined) {
  if (
    !/^(projectHosted|projectCoordination|projectPlanning|projectSelfMetric|projectRecovery|projectAutonomy|projectWorkActions)/.test(
      name,
    ) ||
    !args
  )
    return false;
  let command = args;
  const payload = args.request ?? args.command;
  if (typeof payload === 'string') {
    try {
      command = JSON.parse(payload);
    } catch {
      return false;
    }
  }
  return typeof command.operationId === 'string' && command.operationId.length > 0;
}
