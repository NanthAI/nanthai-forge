import { indexProgressReporter } from './work-index-client.js';
// SPDX-License-Identifier: Apache-2.0
import { exchangeFetch, type ExchangeRequestOptions } from './exchange-request.js';
import { ForgeError } from './errors.js';
import { LONG_ACTION_DEADLINE_MS, pendingProgressGuard } from './long-action.js';
import { Agent, type Dispatcher } from 'undici';

// Node fetch otherwise inherits Undici's five-minute header deadline. Override
// the dispatched request as well as our AbortController deadline.
class LongActionAgent extends Agent {
  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) {
    return super.dispatch({ ...options, headersTimeout: LONG_ACTION_DEADLINE_MS }, handler);
  }
}
const actionDispatcher = new LongActionAgent();

// Reads, content-addressed commits, and pinned publication pages are replay-safe.
const replaySafe = new Set([
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
  'projectObjects:prepareBatch',
  'projectObjects:completeBatch',
  'projectObjects:reconcile',
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
const longActions = new Set([
  'projectExchangeActions:manifest',
  'projectObjectRecipes:complete',
  'projectWorkActions:initialize',
  'projectExchangeMigration:migrate',
  'projectWorkActions:exportJournal',
  'projectWorkIndexActions:ensure',
]);
const receiptCalls = new Set(['projectExchangeMigration:migrate']);

/** The HTTP client uses this for every exchange query, mutation and action,
 * including direct calls from bound exchange and the upload/transport helpers. */
export function exchangeConvexFetch(
  options: ExchangeRequestOptions = {},
  onCall?: (name: string, pending: boolean) => void,
): typeof fetch {
  return async (url, init) => {
    const payload = typeof init?.body === 'string' ? JSON.parse(init.body) : {},
      name = typeof payload.path === 'string' ? payload.path : 'exchange Convex request',
      safe =
        replaySafe.has(name) ||
        (receiptCalls.has(name) && typeof payload.args?.[0]?.operationId === 'string'),
      longAction = String(url).endsWith('/api/action') && longActions.has(name);
    const continuable = longAction && name === 'projectWorkIndexActions:ensure';
    const guard = pendingProgressGuard(name, payload.args?.[0]?.operationId ?? name);
    let progressName: string | undefined;
    const indexProgress = name === 'projectWorkIndexActions:ensure' ? indexProgressReporter() : undefined;
    onCall?.(name, true);
    try {
      const request: RequestInit & { dispatcher?: Dispatcher } = {
        ...init,
        ...(longAction ? { dispatcher: actionDispatcher } : {}),
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
          throw new ForgeError(
            'EXCHANGE_REQUEST_FAILED',
            `${name} returned HTTP ${response.status} after bounded retries. Retry the original operation to reconcile its outcome.`,
          );
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
