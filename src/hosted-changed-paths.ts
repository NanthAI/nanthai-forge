// SPDX-License-Identifier: Apache-2.0
import { protectedPathNotice, type ProtectedPathPolicy } from './public-governance.js';
import { digest } from './hash.js';
import { machineObjectsDirectory } from './machine-object-store.js';
import type { HostedLaneCheckoutMarker } from './hosted-lane-checkout-marker.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clientCacheRoot } from './root-paths.js';
import { HostedCheckoutCache } from './hosted-checkout-cache.js';
import { ConvexLaneTransport } from './hosted-lane-transport.js';
import { parseNativeState } from './state/format.js';
import { reviewPaths } from './source-review-format.js';
import { hostedMainV2Schema } from './hosted-main.js';
import type { HostedAgentTransport } from './hosted-agent-transport.js';

export type SavedChangedPaths = {
  paths: string[];
  complete: boolean;
  source?: 'projection' | 'manifests';
  /** The exact main used to remove paths already accepted, when the fallback read it. */
  mainHead?: string;
};

/** The Lane's saved paths against its base. The server projection is the cheap path, but it is
 * incomplete for any head that arrived without a delta (a sync or resolution merge, an oversized
 * change set). Then the pinned State manifests give the exact answer: the base-to-head paths, minus
 * paths whose bytes already equal current main (merged-in main content is not this Lane's change and
 * main's own landing verified it). At most three cached object reads, one main read and in-memory
 * comparison, only when the projection is incomplete. Any failure keeps the projection's "unknown":
 * a missing observation never becomes "no changes". */
export async function savedChangedPaths(
  transport: Pick<HostedAgentTransport, 'root' | 'exchange' | 'query'>,
  lane: { base: string; head: string },
  projected: { paths: string[]; complete: boolean } | undefined,
  /** `lane.base` is not the Lane's recorded base (laneChangeBase): the projection measures from that
   * one, so the manifests answer, and the projection is only the fallback. */
  ownBase = false,
): Promise<SavedChangedPaths | undefined> {
  if (projected?.complete && !ownBase) return { ...projected, source: 'projection' };
  try {
    // A main that cannot be read only costs precision: the base-to-head set is a superset.
    const main = await transport
      .query('projectHostedChannels:current', {})
      .then(value => hostedMainV2Schema.parse(value).head)
      .catch(() => undefined);
    const cache = new HostedCheckoutCache(
      clientCacheRoot(transport.root),
      new ConvexLaneTransport(transport.exchange),
    );
    await cache.ensure([lane.base, lane.head, ...(main ? [main] : [])]);
    const read = (id: string) => parseNativeState(readFileSync(join(cache.objects, id))).files;
    const current = main && main !== lane.base ? new Map(read(main).map(file => [file.path, file])) : null;
    const paths = reviewPaths(read(lane.base), read(lane.head))
      .filter(item => item.status !== 'unchanged')
      .filter(
        item =>
          !current ||
          !(
            current.get(item.path)?.blob === item.after?.blob &&
            current.get(item.path)?.mode === item.after?.mode
          ),
      )
      .map(item => item.path);
    return { paths, complete: true, source: 'manifests', ...(main ? { mainHead: main } : {}) };
  } catch {
    return projected;
  }
}

/** Where this machine keeps verified objects for a checkout: its own cache, then the machine store. */
const objectDirectories = (root: string) =>
  [join(clientCacheRoot(root), 'objects'), machineObjectsDirectory()].filter((dir): dir is string => !!dir);

/** An object's bytes from this machine's caches, verified against its digest; null when not cached. */
export function cachedObject(root: string, id: string): Buffer | null {
  if (!/^[a-f0-9]{64}$/.test(id)) return null;
  for (const directory of objectDirectories(root)) {
    try {
      const bytes = readFileSync(join(directory, id));
      if (digest(bytes) === id) return bytes;
    } catch {
      /* Not cached here: try the next place. */
    }
  }
  return null;
}

/** The Lane base's file entries from the base State manifest already on this machine; null when
 * that manifest is not cached. No server call. */
export function baseStateFiles(root: string, marker: HostedLaneCheckoutMarker) {
  const bytes = cachedObject(root, marker.selection.base.head);
  if (!bytes) return null;
  try {
    return parseNativeState(bytes).files;
  } catch {
    return null;
  }
}

/** Paths the Lane's saved head changes against its base, from the base State manifest already on this
 * machine (the checkout's own cache or the machine object store). No server call. `null` when that
 * manifest is not cached: a missing observation never becomes "no changes" or a count. */
export function pathsAgainstBase(root: string, marker: HostedLaneCheckoutMarker): string[] | null {
  const base = baseStateFiles(root, marker);
  return base
    ? reviewPaths(base, marker.state.files)
        .filter(item => item.status !== 'unchanged')
        .map(item => item.path)
    : null;
}

/** Local manifests only; missing coverage stays explicit and never adds a server call. */
export function checkoutProtectedPathNotice(
  root: string,
  marker: HostedLaneCheckoutMarker,
  policy: ProtectedPathPolicy,
  mainHead?: string,
) {
  return mainFilteredNotice(root, policy, pathsAgainstBase(root, marker), marker.state.files, mainHead);
}

type FileEntry = { path: string; blob?: string; mode?: string };
/** Paths whose saved bytes differ from main's, by main's State manifest when this machine already
 * has it (after a sync it does). Content merged in from main, or an edit reverted to main's bytes,
 * is not this Lane's change, so it needs no approval (ad80e037). No server call: without the cached
 * manifest, or on any read error, the paths come back unchanged. */
export function withoutMainBytes(
  root: string,
  mainHead: string | undefined,
  files: readonly FileEntry[] | undefined,
  paths: string[] | null,
): string[] | null {
  if (!paths || !mainHead || !files) return paths;
  const bytes = cachedObject(root, mainHead);
  if (!bytes) return paths;
  let main: Map<string, FileEntry>;
  try {
    main = new Map(parseNativeState(bytes).files.map(file => [file.path, file]));
  } catch {
    return paths;
  }
  const saved = new Map(files.map(file => [file.path, file]));
  return paths.filter(path => {
    const mine = saved.get(path),
      theirs = main.get(path);
    return mine?.blob !== theirs?.blob || mine?.mode !== theirs?.mode;
  });
}

/** The protected-path notice for these changed paths, dropping paths whose saved bytes equal main's.
 * The main comparison runs only when a protected path matched, so ordinary saves read nothing more. */
export function mainFilteredNotice(
  root: string,
  policy: ProtectedPathPolicy,
  paths: string[] | null,
  files: readonly FileEntry[] | undefined,
  mainHead: string | undefined,
) {
  const notice = protectedPathNotice(policy, paths);
  return notice?.coverage === 'complete' && mainHead && files
    ? protectedPathNotice(policy, withoutMainBytes(root, mainHead, files, paths))
    : notice;
}
