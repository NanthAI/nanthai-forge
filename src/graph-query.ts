// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
import type { GraphPack, QueryResult, Snapshot, SymbolNode } from './types.js';

export class GraphQuery {
  readonly pack: GraphPack;
  snapshot: Snapshot;
  freshness: 'current' | 'stale';
  constructor(pack: GraphPack, snapshot: Snapshot) {
    this.pack = pack;
    this.snapshot = snapshot;
    this.freshness = 'current';
  }
  status(): object {
    this.refresh();
    return {
      sourceId: this.pack.source.id,
      currentSourceId: this.snapshot.source.id,
      analysisId: this.pack.id,
      gitHead: this.pack.source.gitHead,
      currentGitHead: this.snapshot.source.gitHead,
      freshness: this.freshness,
      analysis: this.pack.analysis,
      files: this.pack.source.files.length,
      symbols: this.pack.nodes.length,
      imports: this.pack.imports.length,
      references: this.pack.references.length,
      syntaxIssues: this.pack.issues.length,
      excluded: this.snapshot.source.excluded,
    };
  }
  private check(limit: number): void {
    this.refresh();
    invariant(
      this.freshness === 'current',
      'SOURCE_STALE',
      'Working source differs from the index. Re-index before requesting source context.',
    );
    invariant(
      Number.isInteger(limit) && limit >= 1 && limit <= 100,
      'BAD_LIMIT',
      'Query limit must be between 1 and 100.',
    );
  }
  private result<T>(items: T[], limit: number): QueryResult<T> {
    const selected: T[] = [];
    let bytes = 0;
    for (const item of items.slice(0, limit)) {
      bytes += Buffer.byteLength(JSON.stringify(item));
      if (bytes > 48_000) break;
      selected.push(item);
    }
    return {
      schemaVersion: 1,
      sourceId: this.pack.source.id,
      analysisId: this.pack.id,
      gitHead: this.pack.source.gitHead,
      freshness: this.freshness,
      coverage: 'partial',
      limitations: this.pack.analysis.limitations,
      total: items.length,
      truncated: items.length > selected.length,
      results: selected,
    };
  }
  protected refresh(): void {}
  files(search = '', offset = 0, limit = 50): object {
    invariant(search.length <= 256, 'BAD_QUERY', 'Search text is limited to 256 characters.');
    invariant(
      Number.isSafeInteger(offset) && offset >= 0,
      'BAD_OFFSET',
      'Offset must be a non-negative integer.',
    );
    this.check(limit);
    const rows = this.pack.source.files.filter(f => f.path.toLowerCase().includes(search.toLowerCase()));
    const result = this.result(rows.slice(offset), limit);
    return { ...result, total: rows.length, offset, truncated: offset + result.results.length < rows.length };
  }
  graph(offset = 0, edgeOffset = 0, limit = 50): object {
    this.check(limit);
    invariant(
      Number.isSafeInteger(edgeOffset) && edgeOffset >= 0,
      'BAD_OFFSET',
      'Edge offset must be a non-negative integer.',
    );
    invariant(
      Number.isSafeInteger(offset) && offset >= 0,
      'BAD_OFFSET',
      'Offset must be a non-negative integer.',
    );
    const page = this.result(this.pack.source.files.slice(offset), limit);
    const files = {
      ...page,
      offset,
      total: this.pack.source.files.length,
      truncated: offset + page.results.length < this.pack.source.files.length,
    };
    const relationships = this.result(this.pack.imports.slice(edgeOffset), limit);
    return {
      files,
      relationships: {
        ...relationships,
        offset: edgeOffset,
        total: this.pack.imports.length,
        truncated: edgeOffset + relationships.results.length < this.pack.imports.length,
      },
    };
  }
  declarations(file: string, limit = 100): QueryResult<SymbolNode> {
    this.check(limit);
    return this.result(
      this.pack.nodes.filter(node => node.locator.file === file),
      limit,
    );
  }
  impact(file: string, limit = 20): object {
    this.check(limit);
    invariant(
      this.pack.source.files.some(f => f.path === file),
      'SOURCE_NOT_INDEXED',
      'File is not indexed.',
    );
    return {
      ...this.result(
        this.pack.imports.filter(edge => edge.target === file),
        limit,
      ),
      meaning: 'Direct reverse imports only. Not a complete impact analysis or permission to skip tests.',
    };
  }
  context(search = '', limit = 20): object {
    invariant(search.length <= 256, 'BAD_QUERY', 'Search text is limited to 256 characters.');
    this.check(limit);
    const q = search.toLowerCase();
    const results = this.pack.nodes.filter(
      n => !q || n.name.toLowerCase().includes(q) || n.locator.file.toLowerCase().includes(q),
    );
    const files = this.pack.source.files
      .filter(f => !q || f.path.toLowerCase().includes(q))
      .map(f => ({ kind: 'File', ...f }));
    return {
      ...this.result<object>([...files, ...results], limit),
      analysis: this.pack.analysis,
      fileCount: this.pack.source.files.length,
      syntaxIssueCount: this.pack.issues.length,
    };
  }
  inspect(nameOrId: string, limit = 20): QueryResult<SymbolNode> {
    this.check(limit);
    return this.result(
      this.pack.nodes.filter(n => n.id === nameOrId || n.name === nameOrId),
      limit,
    );
  }
  references(nameOrId: string, limit = 20): object {
    // Check freshness before resolving names so stale names are not returned as current context.
    this.check(limit);
    const nodes = this.pack.nodes.filter(n => n.id === nameOrId || n.name === nameOrId);
    invariant(
      nodes.length === 1,
      'AMBIGUOUS_OR_MISSING_SYMBOL',
      'Use inspect to obtain one exact symbol ID.',
    );
    return this.result(
      this.pack.references.filter(r => r.target === nodes[0]!.id),
      limit,
    );
  }
  imports(file: string, limit = 20): object {
    this.check(limit);
    return this.result(
      this.pack.imports.filter(e => e.from === file),
      limit,
    );
  }
  source(file: string, start = 1, end = start + 39): object {
    this.check(1);
    invariant(
      Number.isInteger(start) && Number.isInteger(end) && start > 0 && end >= start && end - start < 200,
      'BAD_RANGE',
      'Source range must be 1-based and contain at most 200 lines.',
    );
    const text = this.snapshot.content.get(file);
    invariant(text !== undefined, 'SOURCE_NOT_INDEXED', 'Only captured, included source files can be read.');
    const lines = text.split('\n');
    invariant(start <= lines.length, 'BAD_RANGE', 'Start line is past the end of the source file.');
    const snippet = lines.slice(start - 1, Math.min(end, lines.length)).join('\n');
    invariant(
      snippet.length <= 20_000,
      'OUTPUT_LIMIT',
      'Requested source exceeds the output limit; request fewer lines.',
    );
    return this.result(
      [
        {
          file,
          digest: this.pack.source.files.find(f => f.path === file)!.digest,
          startLine: start,
          endLine: Math.min(end, lines.length),
          totalLines: lines.length,
          text: snippet,
        },
      ],
      1,
    );
  }
}
