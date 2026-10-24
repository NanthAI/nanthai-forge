// SPDX-License-Identifier: Apache-2.0
// A hook-only React host and a fake Convex client that counts server subscriptions.
// Components under test render null-equivalent trees; no layout or DOM behaviour is modelled.
import { convexToJson } from 'convex/values';
import { getFunctionName } from 'convex/server';

const noop = () => {};
function element() {
  return {
    nodeType: 1,
    nodeName: 'DIV',
    tagName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    style: {},
    addEventListener: noop,
    removeEventListener: noop,
    appendChild: noop,
    removeChild: noop,
    insertBefore: noop,
    setAttribute: noop,
    removeAttribute: noop,
    ownerDocument: null,
  };
}

/** Installs just enough of `window`/`document` for react-dom/client to commit hook-only trees. */
export function installHookHost() {
  const previous = { window: globalThis.window, document: globalThis.document };
  const document = Object.assign(new EventTarget(), {
    createElement: element,
    visibilityState: 'visible',
    hidden: false,
    activeElement: null,
  });
  const window = Object.assign(new EventTarget(), {
    document,
    location: { hash: '', pathname: '/', search: '' },
    HTMLIFrameElement: class {},
  });
  globalThis.window = window;
  globalThis.document = document;
  globalThis.HTMLIFrameElement = window.HTMLIFrameElement;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const container = element();
  container.ownerDocument = document;
  return {
    container,
    document,
    window,
    setVisibility(state) {
      document.visibilityState = state;
      document.hidden = state === 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
    },
    restore() {
      for (const [key, value] of Object.entries(previous))
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      delete globalThis.HTMLIFrameElement;
    },
  };
}

const tokenOf = (name, args) => `${name}:${JSON.stringify(convexToJson(args ?? {}))}`;

/**
 * A fake Convex React client. `resolve(name, args, journal)` returns a query value; paginated
 * `projectWorkIndex:records` reads are served from `collections` with journaled end cursors and a
 * midpoint `splitCursor` like the hosted backend. Every server subscription (Add) is counted; an
 * Add for a token whose value was already computed counts as a cached call.
 */
export function fakeConvex({ resolve = () => null, collections = {}, generationId = 'g1' } = {}) {
  const live = new Map(); // token -> { name, args, listeners:Set, value }
  const computed = new Set();
  const journals = new Map();
  const stats = { adds: 0, removes: 0, cached: 0, executions: 0, bytes: 0 };
  let pending = new Set();
  const page = (args, token) => {
    const rows = collections[args.collection] ?? [];
    const ordered = args.newestFirst ? [...rows].reverse() : rows;
    const { cursor, endCursor, numItems } = args.paginationOpts;
    let start = cursor ? ordered.findIndex(row => String(row.position) === cursor) + 1 : 0;
    if (start < 0) start = 0;
    let end;
    const fixed = endCursor ?? journals.get(token);
    if (fixed !== undefined && fixed !== null)
      end = fixed === '' ? ordered.length : ordered.findIndex(row => String(row.position) === fixed) + 1;
    else end = Math.min(ordered.length, start + Math.min(numItems, 100));
    const slice = ordered.slice(start, end);
    const isDone = end >= ordered.length && endCursor === undefined;
    const continueCursor = slice.length ? String(slice.at(-1).position) : (cursor ?? '');
    if (endCursor === undefined && !journals.has(token)) journals.set(token, continueCursor || '');
    return {
      generationId,
      revision: 1,
      page: slice,
      isDone,
      continueCursor,
      splitCursor: slice.length > 1 ? String(slice[Math.floor(slice.length / 2) - 1].position) : null,
      pageStatus: null,
    };
  };
  const execute = entry => {
    stats.executions++;
    const value =
      entry.name === 'projectWorkIndex:records'
        ? page(entry.args, entry.token)
        : resolve(entry.name, entry.args);
    stats.bytes += JSON.stringify(value ?? null).length;
    computed.add(entry.token);
    return value;
  };
  const flush = () => {
    const batch = pending;
    pending = new Set();
    for (const entry of batch) {
      if (!live.has(entry.token)) continue;
      entry.value = execute(entry);
      for (const listener of [...entry.listeners]) listener();
    }
  };
  const schedule = entry => {
    pending.add(entry);
    queueMicrotask(flush);
  };
  const watchQuery = (query, args = {}) => {
    const name = getFunctionName(query),
      token = tokenOf(name, args);
    return {
      onUpdate(listener) {
        let entry = live.get(token);
        if (!entry) {
          entry = { name, args, token, listeners: new Set(), value: undefined };
          live.set(token, entry);
          stats.adds++;
          if (computed.has(token)) stats.cached++;
          schedule(entry);
        }
        entry.listeners.add(listener);
        return () => {
          entry.listeners.delete(listener);
          if (entry.listeners.size === 0 && live.get(token) === entry) {
            live.delete(token);
            stats.removes++;
          }
        };
      },
      localQueryResult: () => live.get(token)?.value,
      journal: () => undefined,
    };
  };
  const client = {
    watchQuery,
    watchPaginatedQuery: () => {
      throw new Error('watchPaginatedQuery is not used by the hosted app');
    },
    logger: { warn: noop, log: noop, error: noop, logVerbose: noop },
    action: async () => '',
    mutation: async () => null,
    query: async (query, args) => resolve(getFunctionName(query), args ?? {}),
    connectionState: () => ({ isWebSocketConnected: true, hasInflightRequests: false }),
    subscribeToConnectionState: () => noop,
  };
  return {
    client,
    stats,
    live,
    /** Live subscription count per function name. */
    count(name) {
      return [...live.values()].filter(entry => !name || entry.name === name).length;
    },
    /** Re-run every live subscription (a server-side invalidation). */
    invalidate() {
      for (const entry of live.values()) schedule(entry);
    },
    reset() {
      Object.assign(stats, { adds: 0, removes: 0, cached: 0, executions: 0, bytes: 0 });
    },
  };
}
