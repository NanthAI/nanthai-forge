// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clientCacheRoot } from './root-paths.js';
import { HostedCheckoutCache } from './hosted-checkout-cache.js';
import { ConvexLaneTransport } from './hosted-lane-transport.js';
import { parseNativeState } from './native-state-format.js';
import { reviewPaths } from './source-review-format.js';
import { hostedMainV2Schema } from './hosted-main.js';
import type { HostedAgentTransport } from './hosted-agent-transport.js';

export type SavedChangedPaths = { paths: string[]; complete: boolean; source?: 'projection' | 'manifests' };

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
): Promise<SavedChangedPaths | undefined> {
  if (projected?.complete) return { ...projected, source: 'projection' };
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
    return { paths, complete: true, source: 'manifests' };
  } catch {
    return projected;
  }
}
