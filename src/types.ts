// SPDX-License-Identifier: Apache-2.0
export const AGENT_TOOLS = [
  'status',
  'files',
  'context',
  'inspect',
  'refs',
  'imports',
  'impact',
  'source',
  'declarations',
] as const;
export type AgentTool = (typeof AGENT_TOOLS)[number];
export interface Limits {
  maxPaths: number;
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}
export interface Position {
  offset: number;
  line: number;
  column: number;
}
export interface Locator {
  file: string;
  digest: string;
  start: Position;
  end: Position;
}
export interface FileRecord {
  path: string;
  digest: string;
  bytes: number;
}
export interface SourceIdentity {
  id: string;
  gitHead: string | null;
  scope:
    | 'included-typescript-working-tree'
    | 'included-typescript-git-revision'
    | 'included-language-working-tree'
    | 'included-language-git-revision';
  files: FileRecord[];
  inventoryDigest: string;
  policy: { version: 1 | 2; limits: Limits };
  excluded: Record<string, number>;
}
export interface Snapshot {
  root: string;
  source: SourceIdentity;
  content: Map<string, string>;
}
export interface SymbolNode {
  id: string;
  name: string;
  kind: string;
  exported: boolean;
  locator: Locator;
}
export interface ImportEdge {
  from: string;
  specifier: string;
  target: string | null;
  resolution: 'resolved' | 'external' | 'unresolved';
  locator: Locator;
}
export interface ReferenceEdge {
  target: string;
  locator: Locator;
}
export interface AnalysisIssue {
  file: string;
  code: string;
  offset: number;
}
export interface GraphPack {
  schemaVersion: 1;
  id: string;
  source: SourceIdentity;
  analysis: {
    provider: 'typescript-compiler' | 'forge-language-analyzers';
    version: string;
    configVersion: 1 | 2;
    resolution: 'captured-relative-ts-only' | 'captured-language-structure';
    languages?: { language: string; parser: string; version: string; relationships: string[] }[];
    coverage: 'partial';
    limitations: string[];
  };
  nodes: SymbolNode[];
  imports: ImportEdge[];
  references: ReferenceEdge[];
  issues: AnalysisIssue[];
}
export type Freshness = 'current' | 'stale';
export interface QueryResult<T> {
  schemaVersion: 1;
  sourceId: string;
  analysisId: string;
  gitHead: string | null;
  freshness: Freshness;
  coverage: 'partial';
  limitations: string[];
  total: number;
  truncated: boolean;
  results: T[];
}
