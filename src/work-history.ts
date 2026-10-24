// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { invariant } from './errors.js';
import { evidenceView } from './work-evidence.js';
import { workGit } from './work-git.js';
import type { HistoryCommand } from './work-types.js';
import type { WorkStore } from './work-store.js';

type AvailableCommit = {
  id: string;
  status: 'available';
  tree: string;
  parents: string[];
  author: string | null;
  committer: string | null;
  message: string;
  signatureFields: string[];
  displayEncoding: string;
  bytes: number;
  raw?: { encoding: 'base64'; data: string };
};
type HistoryEntry = AvailableCommit | { id: string; status: 'unavailable'; reason: string };
const oid = /^[0-9a-f]{40,64}$/;
const pageBytes = 4 * 1024 * 1024; // Same existing Git command output budget, not a history retention cap.

function commit(root: string, id: string, rawExport: boolean): HistoryEntry {
  const output = workGit(
    root,
    ['--no-lazy-fetch', '--no-replace-objects', 'cat-file', '--batch'],
    `${id}\n`,
    false,
    true,
  );
  const end = output.indexOf(10),
    header = output.subarray(0, end).toString('ascii');
  if (header === `${id} missing`)
    return {
      id,
      status: 'unavailable',
      reason: 'Commit object is not locally available. No fetch was attempted.',
    };
  const parts = header.split(' '),
    size = Number(parts[2]);
  invariant(
    end >= 0 &&
      parts[0] === id &&
      Number.isSafeInteger(size) &&
      size >= 0 &&
      output.length === end + size + 2,
    'INVALID_HISTORY',
    'Git returned an invalid object response. No history success is claimed.',
  );
  if (parts[1] !== 'commit')
    return {
      id,
      status: 'unavailable',
      reason: 'The referenced object is not a commit. No ancestry is inferred.',
    };
  const bytes = output.subarray(end + 1, end + 1 + size);
  const identity = createHash(id.length === 64 ? 'sha256' : 'sha1')
    .update(`commit ${size}\0`)
    .update(bytes)
    .digest('hex');
  invariant(identity === id, 'INVALID_HISTORY', 'Commit bytes do not match the selected object ID.');
  const split = bytes.indexOf('\n\n');
  invariant(split >= 0, 'INVALID_HISTORY', 'Commit headers and message could not be separated.');
  let text: string,
    displayEncoding = 'UTF-8 display; original bytes preserved in export';
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    text = bytes.toString('utf8');
    displayEncoding = 'UTF-8 replacement display; original non-UTF-8 bytes preserved in export';
  }
  const headers = bytes
    .subarray(0, split)
    .toString('utf8')
    .split('\n')
    .filter(line => !line.startsWith(' '));
  const values = (key: string) =>
    headers.filter(line => line.startsWith(`${key} `)).map(line => line.slice(key.length + 1));
  const tree = values('tree')[0],
    parents = values('parent');
  invariant(
    tree && oid.test(tree) && parents.every(parent => oid.test(parent)),
    'INVALID_HISTORY',
    'Commit tree or parent IDs are invalid.',
  );
  return {
    id,
    status: 'available',
    tree,
    parents,
    author: values('author')[0] ?? null,
    committer: values('committer')[0] ?? null,
    message: text.slice(text.indexOf('\n\n') + 2),
    signatureFields: headers
      .filter(line => /^gpgsig(?:-sha256)? /.test(line))
      .map(line => line.split(' ')[0]!),
    displayEncoding,
    bytes: size,
    ...(rawExport ? { raw: { encoding: 'base64' as const, data: bytes.toString('base64') } } : {}),
  };
}

export function historyWork(store: WorkStore, command: HistoryCommand, revision: number) {
  invariant(Number.isSafeInteger(revision) && revision >= 0, 'BAD_ARGUMENT', 'Send a valid work revision.');
  const data = store.load();
  const view = evidenceView(data, command.viewId, command.expectedHead);
  const pending = [command.expectedHead],
    seen = new Set<string>(),
    entries: HistoryEntry[] = [];
  let position = 0,
    bytes = 0,
    gapsObserved = 0,
    nextOffset: number | null = null;
  // ponytail: rewalk the pinned prefix for offset pagination; batch traversal if measured large-history latency warrants it.
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    if (position >= command.offset && entries.length === command.limit) {
      nextOffset = position;
      break;
    }
    const entry = commit(store.root, id, command.action === 'export-history');
    if (position >= command.offset) {
      if (entry.status === 'available' && entries.length && bytes + entry.bytes > pageBytes) {
        nextOffset = position;
        break;
      }
      entries.push(entry);
      if (entry.status === 'available') bytes += entry.bytes;
    }
    seen.add(id);
    position++;
    if (entry.status === 'available') pending.push(...entry.parents.slice().reverse());
    else gapsObserved++;
  }
  return {
    revision: data.revision,
    result: {
      schema: 1,
      kind: 'local-git-history' as const,
      private: true,
      viewId: view.id,
      head: command.expectedHead,
      observedAt: new Date().toISOString(),
      offset: command.offset,
      limit: command.limit,
      nextOffset,
      truncated: nextOffset !== null,
      gapsObserved,
      entries,
      order: 'depth-first, original parent order, each ID once',
      provenance:
        'Observed local Git commit objects. Author/committer timestamps and signatures are original claims, not verified identity or inferred Intents.',
      coverage:
        'Locally available parent ancestry only. Object availability can change between pages; no automatic fetch, interpretation or validation reuse.',
    },
  };
}
export type HistoryPage = ReturnType<typeof historyWork>['result'];
