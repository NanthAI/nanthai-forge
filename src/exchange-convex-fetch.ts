// SPDX-License-Identifier: Apache-2.0
import { exchangeFetch, type ExchangeRequestOptions } from './exchange-request.js';
import { ForgeError } from './errors.js';
import { Agent, type Dispatcher } from 'undici';

// Node fetch otherwise inherits Undici's five-minute header deadline. Override
// the dispatched request as well as our AbortController deadline.
class LongActionAgent extends Agent {
  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) {
    return super.dispatch({ ...options, headersTimeout: 600_000 }, handler);
  }
}
const actionDispatcher = new LongActionAgent();

// Reads, content-addressed commits, and pinned publication pages are replay-safe.
const replaySafe = new Set([
  'projectMain:current',
  'projectMain:objects',
  'projectObjects:missing',
  'projectObjects:available',
  'projectWork:state',
  'projectPublicationStore:capabilities',
  'projectPublicationStore:begin',
  'projectPublicationStore:append',
  'projectObjects:prepareBatch',
  'projectObjects:completeBatch',
  'projectObjects:reconcile',
  'projectObjectDownloads:signDownloads',
  'projectObjectCommit:commitBatch',
  'projectObjectRecipes:complete',
  'projectExchangeActions:published',
  'projectExchangeActions:checkpoint',
  'projectExchangeActions:downloadBatch',
  'projectExchangeActions:downloadPart',
  'projectProposalObjects:checkpoint',
  'projectWorkActions:exportJournal',
  'projectWorkJournal:page',
  'projectWorkIndexActions:ensure',
]);
const longActions = new Set([
  'projectExchangeActions:publish',
  'projectExchangeActions:manifest',
  'projectExchangeActions:completeHistory',
  'projectObjectRecipes:complete',
  'projectWorkActions:initialize',
  'projectExchangeMigration:migrate',
  'projectSourceReturn:returnSource',
  'projectWorkActions:exportJournal',
  'projectWorkIndexActions:ensure',
]);
const receiptCalls = new Set([
  'projectExchangeActions:publish',
  'projectExchangeMigration:migrate',
  'projectSourceReturn:returnSource',
]);

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
    onCall?.(name, true);
    try {
      const request: RequestInit & { dispatcher?: Dispatcher } = {
        ...init,
        ...(longAction ? { dispatcher: actionDispatcher } : {}),
      };
      const response = await exchangeFetch(name, url, request, {
        // Actions may rebuild retained Work before sending any response bytes.
        ...(longAction ? { headerTimeoutMs: 600_000, totalTimeoutMs: 600_000 } : {}),
        ...options,
        retries: safe ? (options.retries ?? 3) : 0,
      });
      if (response.status === 429 || (response.status >= 500 && response.status !== 560))
        throw new ForgeError(
          'EXCHANGE_REQUEST_FAILED',
          `${name} returned HTTP ${response.status} after bounded retries. Retry the original operation to reconcile its outcome.`,
        );
      return response;
    } finally {
      onCall?.(name, false);
    }
  };
}
