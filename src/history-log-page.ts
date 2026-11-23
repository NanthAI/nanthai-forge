// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { gzipSync, gunzipSync } from 'node:zlib';
import { gitHash } from './hosted-github-git.js';
import { invariant } from './errors.js';
import type { HistoryEntry } from './history-git.js';

/** One log page over retained commit/tree metadata. No blob content is needed, including
 * path history: compare the selected entry's object id with its parents' entries. */
export function historyLogPage(
  source: { commits: Map<string, Buffer>; get(id: string): Buffer | undefined },
  selected: string,
  options: { path?: string | undefined; limit: number; skip: number },
) {
  const matches = [...source.commits.keys()].filter(id => id.startsWith(selected));
  invariant(
    matches.length === 1,
    'NOT_FOUND',
    `Commit ${selected} is absent or ambiguous in stored history.`,
  );
  const commit = matches[0]!;
  const parsed = new Map<string, { entry: HistoryEntry; tree: string; time: number }>();
  const read = (id: string) => {
    const cached = parsed.get(id);
    if (cached) return cached;
    const bytes = source.commits.get(id);
    invariant(bytes, 'HISTORY_UNAVAILABLE', 'Stored history has an incomplete commit chain.');
    const text = bytes.toString('utf8');
    const boundary = text.indexOf('\n\n');
    invariant(boundary >= 0, 'GIT_OBJECT_INVALID', 'A stored commit has no message boundary.');
    const header = text.slice(0, boundary);
    const encoding = /^encoding (.+)$/m.exec(header)?.[1];
    invariant(
      !encoding || /^utf-?8$/i.test(encoding),
      'GIT_OBJECT_INVALID',
      'Git must decode this commit encoding.',
    );
    const tree = /^tree ([0-9a-f]{40})$/m.exec(header)?.[1];
    const author = /^author (.*) <[^\n]*> (-?\d+) ([+-]\d{4})$/m.exec(header);
    const committer = /^committer .* <[^\n]*> (-?\d+) ([+-]\d{4})$/m.exec(header);
    invariant(tree && author && committer, 'GIT_OBJECT_INVALID', 'A stored commit has invalid metadata.');
    const value = {
      tree,
      time: Number(committer[1]),
      entry: {
        commit: id,
        parents: [...header.matchAll(/^parent ([0-9a-f]{40})$/gm)].map(match => match[1]!),
        author: author[1]!,
        authoredAt: iso(author[2]!, author[3]!),
        committedAt: iso(committer[1]!, committer[2]!),
        subject: text
          .slice(boundary + 2)
          .trim()
          .split(/\n\s*\n/, 1)[0]!
          .replace(/\n/g, ' '),
      },
    };
    parsed.set(id, value);
    return value;
  };
  const pathId = (root: string) => {
    if (!options.path) return root;
    let id = root;
    let mode = '40000';
    const components = options.path.split('/');
    for (const [index, component] of components.entries()) {
      const bytes = source.get(id);
      invariant(bytes, 'HISTORY_UNAVAILABLE', 'Stored history has an incomplete tree.');
      let next: string | null = null;
      for (let at = 0; at < bytes.length;) {
        const space = bytes.indexOf(32, at),
          nul = bytes.indexOf(0, space + 1);
        invariant(
          space >= 0 && nul >= 0 && nul + 21 <= bytes.length,
          'GIT_OBJECT_INVALID',
          'A stored tree is malformed.',
        );
        if (bytes.toString('utf8', space + 1, nul) === component) {
          if (index < components.length - 1 && bytes.toString('latin1', at, space) !== '40000') return null;
          mode = bytes.toString('latin1', at, space);
          next = bytes.toString('hex', nul + 1, nul + 21);
          break;
        }
        at = nul + 21;
      }
      if (!next) return null;
      id = next;
    }
    // Executable-bit and entry-type changes are history even when the object id is unchanged.
    return `${mode}:${id}`;
  };
  const pending = [commit],
    seen = new Set<string>(),
    entries: HistoryEntry[] = [];
  let skipped = 0;
  while (pending.length && entries.length <= options.limit) {
    // Git's default date order: newest available commit, with parents discovered after children.
    pending.sort((a, b) => read(b).time - read(a).time);
    const id = pending.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const current = read(id);
    let parents = current.entry.parents;
    let include = true;
    if (options.path) {
      const value = pathId(current.tree);
      const same = parents.find(parent => pathId(read(parent).tree) === value);
      // Default path-history simplification follows a TREESAME merge parent and omits that merge.
      if (same) {
        parents = [same];
        include = false;
      } else include = parents.length > 0 || value !== null;
    }
    pending.push(...parents.filter(parent => !seen.has(parent)));
    if (include) {
      if (skipped < options.skip) skipped++;
      else entries.push(current.entry);
    }
  }
  return { commit, entries: entries.slice(0, options.limit), more: entries.length > options.limit };
}
function iso(seconds: string, zone: string) {
  const sign = zone[0] === '-' ? -1 : 1;
  const minutes = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3)));
  const date = new Date(Number(seconds) * 1000 + minutes * 60_000);
  invariant(Number.isFinite(date.getTime()), 'GIT_OBJECT_INVALID', 'A stored commit has an invalid date.');
  return date.toISOString().slice(0, 19) + (minutes === 0 ? 'Z' : `${zone.slice(0, 3)}:${zone.slice(3)}`);
}

/** A small derived client cache, not source authority. Over-budget metadata keeps the existing
 * disk-backed Git reader; it never makes a previously readable history unavailable. */
export const historyMetadataBytes = 2 * 1024 * 1024;
export function encodeHistoryMetadata(source: {
  kept: number;
  treeIndex(): Buffer;
  commits: Map<string, Buffer>;
}): Buffer | null {
  if (source.kept > 8 * 1024 * 1024) return null;
  const raw = Buffer.from(
    JSON.stringify({
      version: 1,
      trees: source.treeIndex().toString('base64'),
      commits: [...source.commits].map(([id, data]) => [id, data.toString('base64')]),
    }),
  );
  if (raw.length > 12 * 1024 * 1024) return null;
  const bytes = gzipSync(raw);
  return bytes.length <= historyMetadataBytes ? bytes : null;
}
export function loadHistoryMetadata(
  target: { kept: number; loadIndex(bytes: Buffer): boolean; commits: Map<string, Buffer> },
  bytes: Buffer,
) {
  const parsed = JSON.parse(gunzipSync(bytes, { maxOutputLength: 16 * 1024 * 1024 }).toString('utf8')) as {
    version: number;
    trees: string;
    commits: [string, string][];
  };
  invariant(parsed.version === 1, 'GIT_OBJECT_INVALID', 'History metadata cache version is unsupported.');
  invariant(
    target.loadIndex(Buffer.from(parsed.trees, 'base64')),
    'GIT_OBJECT_INVALID',
    'Cached history trees are invalid.',
  );
  for (const [id, encoded] of parsed.commits) {
    const data = Buffer.from(encoded, 'base64');
    invariant(
      gitHash('commit', data) === id,
      'GIT_OBJECT_INVALID',
      'Cached history commit differs from its id.',
    );
    if (!target.commits.has(id)) {
      target.commits.set(id, data);
      target.kept += data.length;
    }
    invariant(
      target.kept <= 128 * 1024 * 1024,
      'GIT_OBJECT_INVALID',
      'History metadata needs the disk-backed reader.',
    );
  }
}
