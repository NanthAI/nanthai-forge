import { readIgnoredStatus } from './ignored-status.js';
// SPDX-License-Identifier: Apache-2.0
import { loadArtifact } from './artifact.js';
import { capture, normalizeRoot } from './snapshot.js';
import { GraphQuery } from './graph-query.js';

export class RepositoryQuery extends GraphQuery {
  constructor(root: string) {
    const normalized = normalizeRoot(root),
      pack = loadArtifact(normalized);
    // Constructor validates the retained index, not current working bytes. Every
    // public operation refreshes once before returning any current context.
    super(pack, { root: normalized, source: pack.source, content: new Map() });
    this.freshness = 'stale';
  }
  override status(ignored = false): object {
    return { ...super.status(), ignored: readIgnoredStatus(this.snapshot.root, ignored) };
  }
  protected override refresh(): void {
    this.snapshot = capture(this.snapshot.root, this.pack.source.policy.limits);
    this.freshness = this.pack.source.id === this.snapshot.source.id ? 'current' : 'stale';
  }
}
