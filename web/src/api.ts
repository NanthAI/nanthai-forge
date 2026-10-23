import { useReadRetry } from './ui/read-retry';
import { routeSearch } from './shell/location';
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import type { FileRecord, ImportEdge, QueryResult, ReferenceEdge, SymbolNode } from '../../src/types';
export type { FileRecord, ImportEdge, QueryResult, ReferenceEdge, SymbolNode };
export interface Status {
  sourceContext?: {
    laneId: string;
    laneName?: string;
    sourceRoot?: string;
    recordedHead?: string;
    workRevision?: number;
    startupRoot: string;
  };
  name: string;
  sourceId: string;
  currentSourceId: string;
  analysisId: string;
  gitHead: string | null;
  freshness: 'current' | 'stale';
  files: number;
  symbols: number;
  sync?: { checkedAt: number; result: 'checked' | 'unavailable' | 'error'; head?: string };
  hosted?: {
    upstream: string;
    visibility: string;
    license: string;
    currentLicense?: string;
    attributionScope?: string;
  };
  upstreamFreshness?: 'current' | 'stale' | 'unknown';
  imports: number;
  references: number;
  syntaxIssues: number;
  analysis: { coverage: string; limitations: string[] };
}
export interface Page<T> extends QueryResult<T> {
  offset?: number;
}
export interface Source {
  file: string;
  digest: string;
  text: string;
  startLine: number;
  endLine: number;
  totalLines: number;
}
export interface Readme {
  file: string | null;
  text: string;
  digest?: string;
  scope: string;
}
/** Reads one source-explorer endpoint (`status`, `files?…`, `source?…`) from the hosted backend. */
export type SourceRequest = <T>(
  path: string,
  signal?: AbortSignal,
  method?: string,
  body?: unknown,
) => Promise<T>;
export function useQuery<T>(path: string | null, request: SourceRequest) {
  const readAttempt = useReadRetry();
  const [attempt, setAttempt] = useState(0);
  const retry = () => setAttempt(value => value + 1);
  const [result, setResult] = useState<{
    path: string | null;
    request: SourceRequest;
    data: T | null;
    error: string;
  } | null>(null);
  useEffect(() => {
    setResult({ path, request, data: null, error: '' });
    if (!path) return;
    const controller = new AbortController();
    request<T>(path, controller.signal)
      .then(data => {
        if (!controller.signal.aborted) setResult({ path, request, data, error: '' });
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) setResult({ path, request, data: null, error: e.message });
      });
    return () => controller.abort();
  }, [path, request, attempt, readAttempt]);
  return result?.path === path && result.request === request
    ? { data: result.data, error: result.error, retry }
    : { data: null, error: '', retry };
}
export function endpoint(name: string, args: Record<string, string | number>): string {
  return `${name}?${new URLSearchParams(Object.entries(args).map(([k, v]) => [k, String(v)]))}`;
}
export interface Route {
  file: string;
  view: 'home' | 'readme' | 'map' | 'source' | 'work';
  state: string;
  line: number;
  symbol?: string;
  lens?: 'imports' | 'references';
  document?: string;
  anchor?: string;
  laneId?: string;
}
export function readRoute(allowWork = true): Route {
  const params = new URLSearchParams(routeSearch());
  const view = params.get('view');
  const line = Number(params.get('line'));
  return {
    file: params.get('file') ?? '',
    view:
      view === 'home' ||
      (view === 'map' && params.get('lens') === 'references') ||
      view === 'source' ||
      (allowWork && view === 'work')
        ? view
        : view === 'readme' || params.has('document')
          ? 'readme'
          : 'source',
    ...(allowWork && params.has('laneId') ? { laneId: params.get('laneId')! } : {}),
    state: params.get('state') ?? '',
    line: Number.isSafeInteger(line) && line > 0 ? line : 1,
    ...(params.get('symbol') ? { symbol: params.get('symbol')! } : {}),
    ...(params.get('lens') === 'references' ? { lens: 'references' as const } : {}),
    ...(params.get('document') ? { document: params.get('document')! } : {}),
    ...(params.get('anchor') ? { anchor: params.get('anchor')! } : {}),
  };
}
export function routeUrl(route: Route, selectLine = true): string {
  const params = new URLSearchParams(
    Object.entries({ ...route, line: selectLine ? String(route.line) : undefined }).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  const codescape = new URLSearchParams(routeSearch()).get('codescape');
  if (codescape) params.set('codescape', codescape);
  const zone = new URLSearchParams(routeSearch()).get('zone');
  if (zone) params.set('zone', zone);
  return `${location.origin}${location.pathname}?${params}`;
}
