// SPDX-License-Identifier: Apache-2.0
/** Operation-local traversal of verified State parents. Never retained across operations. */
export class NativeAncestry {
  private readonly verified = new Map<string, string[]>();
  constructor(private readonly readParents: (id: string) => string[]) {}
  parents(id: string): string[] {
    let parents = this.verified.get(id);
    if (!parents) {
      parents = this.readParents(id);
      this.verified.set(id, parents);
    }
    return parents;
  }
  contains(head: string, ancestor: string): boolean {
    const seen = new Set<string>(),
      pending = [head];
    while (pending.length) {
      const next = pending.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      const parents = this.parents(next);
      if (next === ancestor) return true;
      pending.push(...parents);
    }
    return false;
  }
  ancestors(head: string): Set<string> {
    const seen = new Set<string>(),
      pending = [head];
    while (pending.length) {
      const next = pending.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      pending.push(...this.parents(next));
    }
    return seen;
  }
}
