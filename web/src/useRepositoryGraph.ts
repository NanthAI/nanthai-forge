// SPDX-License-Identifier: Apache-2.0
import { useEffect, useMemo, useState } from 'react';
import { endpoint, type SourceRequest, type FileRecord, type ImportEdge, type Page } from './api';
import { importEdges, pinnedPage, type PointNode } from './graph-model';
type GraphData = {
  scope: string;
  request: SourceRequest;
  files: FileRecord[];
  edges: ImportEdge[];
  total: number;
  scanned: string[];
  partial: number;
  error: string;
  remaining?: boolean;
};
export function useRepositoryGraph({
  request,
  sourceId,
  analysisId,
  file,
  initial,
}: {
  request: SourceRequest;
  sourceId: string;
  analysisId: string;
  file: string;
  initial: Page<ImportEdge> | null;
}) {
  const scope = `${sourceId}:${analysisId}`;
  const [data, setData] = useState<GraphData | null>(null),
    [pages, setPages] = useState(1),
    [retry, setRetry] = useState(0),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    setData(null);
    setPages(1);
  }, [scope, request]);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    const run = async () => {
      // New readers return one source-pinned graph page per action. Older deployed
      // readers keep their existing file/import protocol until explicitly upgraded.
      try {
        const files: FileRecord[] = [],
          edges: ImportEdge[] = [];
        let total = 0,
          remaining = false;
        for (let page = 0; page < pages; page++) {
          const result = await request<{ files: Page<FileRecord>; relationships: Page<ImportEdge> }>(
            endpoint('graph', {
              state: sourceId,
              offset: files.length,
              edgeOffset: edges.length,
              limit: 100,
            }),
            controller.signal,
          );
          pinnedPage(result.files, sourceId, analysisId);
          pinnedPage(result.relationships, sourceId, analysisId);
          files.push(...result.files.results);
          edges.push(...result.relationships.results);
          total = result.files.total;
          remaining = result.files.truncated || result.relationships.truncated;
          if (!remaining) break;
        }
        if (!controller.signal.aborted)
          setData({ scope, request, files, edges, total, remaining, scanned: [], partial: 0, error: '' });
        return;
      } catch (error) {
        if (controller.signal.aborted) return;
        if (!['Unknown source query.', 'Unknown endpoint.'].includes((error as Error).message)) throw error;
      }
      // Requests remain bounded by the existing owner. More files are an explicit presentation action.
      const files: FileRecord[] = [];
      let total = 0;
      for (let page = 0; page < pages; page++) {
        const result = pinnedPage(
          await request<Page<FileRecord>>(
            endpoint('files', { state: sourceId, offset: files.length, limit: 50 }),
            controller.signal,
          ),
          sourceId,
          analysisId,
        );
        files.push(...result.results);
        total = result.total;
        if (!result.truncated || !result.results.length) break;
      }
      if (controller.signal.aborted) return;
      const edges: ImportEdge[] = [],
        scanned: string[] = [];
      let partial = 0,
        error = '';
      setData(previous => ({
        scope,
        request,
        files,
        edges: previous?.scope === scope && previous.request === request ? previous.edges : [],
        total,
        scanned: [],
        partial,
        error,
      }));
      let cursor = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, files.length) }, async () => {
          while (cursor < files.length && !controller.signal.aborted) {
            const entry = files[cursor++]!;
            try {
              const result = pinnedPage(
                await request<Page<ImportEdge>>(
                  endpoint('imports', { state: sourceId, file: entry.path, limit: 100 }),
                  controller.signal,
                ),
                sourceId,
                analysisId,
              );
              if (controller.signal.aborted) return;
              edges.push(...result.results);
              scanned.push(entry.path);
              if (result.truncated) partial++;
            } catch (e) {
              if (!controller.signal.aborted) error = (e as Error).message;
            }
          }
        }),
      );
      if (!controller.signal.aborted)
        setData({ scope, request, files, edges, total, scanned, partial, error });
    };
    void run()
      .catch(e => {
        if (!controller.signal.aborted)
          setData({
            scope,
            request,
            files: [],
            edges: [],
            total: 0,
            scanned: [],
            partial: 0,
            error: (e as Error).message,
          });
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [request, sourceId, analysisId, scope, pages, retry]);
  const current = data?.scope === scope && data.request === request ? data : null;
  const graph = useMemo(() => {
    const all = [
      ...(current?.edges ?? []),
      ...(initial?.sourceId === sourceId &&
      initial.analysisId === analysisId &&
      initial.freshness === 'current'
        ? initial.results
        : []),
    ];
    const edges = importEdges(all),
      nodes = new Map<string, PointNode>();
    for (const entry of current?.files ?? [])
      nodes.set(entry.path, {
        id: entry.path,
        label: entry.path.split('/').at(-1)!,
        detail: entry.path,
        bytes: entry.bytes,
        digest: entry.digest,
      });
    for (const id of [file, ...edges.flatMap(e => [e.from, e.to])])
      if (id && !nodes.has(id)) nodes.set(id, { id, label: id.split('/').at(-1)!, detail: id });
    return { nodes: [...nodes.values()], edges };
  }, [current, initial, file, sourceId, analysisId]);
  return {
    ...graph,
    busy,
    error: current?.error ?? '',
    loaded: current?.files.length ?? 0,
    total: current?.total ?? 0,
    scanned: current?.scanned.length ?? 0,
    partial: current?.partial ?? 0,
    remaining: current?.remaining ?? (current?.files.length ?? 0) < (current?.total ?? 0),
    more: () => setPages(n => n + 1),
    retry: () => setRetry(n => n + 1),
  };
}
