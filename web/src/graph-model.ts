// SPDX-License-Identifier: Apache-2.0
import type { ImportEdge, Page } from './api';
export type PointNode = {
  id: string;
  label: string;
  detail?: string;
  bytes?: number;
  digest?: string;
  status?: string;
  weight?: number;
  marker?: string[];
  fileCount?: number;
  folder?: string;
};
export type PointEdge = { from: string; to: string };
export function pinnedPage<T>(page: Page<T>, sourceId: string, analysisId: string) {
  if (page.sourceId !== sourceId || page.analysisId !== analysisId || page.freshness !== 'current')
    throw new Error('Graph source changed. Select the current source to continue.');
  return page;
}
export function importEdges(edges: ImportEdge[]): PointEdge[] {
  const seen = new Set<string>();
  return edges.flatMap(edge => {
    const key = JSON.stringify([edge.from, edge.target]);
    if (!edge.target || edge.resolution !== 'resolved' || seen.has(key)) return [];
    seen.add(key);
    return [{ from: edge.from, to: edge.target }];
  });
}
export function hashPoint(value: string): number {
  let h = 2166136261;
  for (const c of value) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export function initialPoint(id: string) {
  const a = hashPoint(id) * Math.PI * 2,
    r = 0.12 + Math.sqrt(hashPoint(`${id}:radius`)) * 0.36;
  return { x: 0.5 + Math.cos(a) * r, y: 0.5 + Math.sin(a) * r, z: hashPoint(`${id}:depth`) };
}
