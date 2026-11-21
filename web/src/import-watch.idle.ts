// SPDX-License-Identifier: Apache-2.0
import type { ConvexReactClient } from 'convex/react';
import type { Id } from '../../convex/_generated/dataModel';
import { api } from '../../convex/_generated/api';

/** Subscribe to source-free invalidation; source reads retain GitHub authority. */
export function watchImport(
  client: ConvexReactClient,
  id: Id<'imports'>,
  refresh: () => void,
  zone?: Id<'sourceZones'> | null,
) {
  const watch = client.watchQuery(api.importStatus.watch, { id, ...(zone ? { zone } : {}) });
  let previous: string | null | undefined;
  let observed = false;
  const update = () => {
    let value: string | null | undefined;
    try {
      value = watch.localQueryResult();
    } catch {
      refresh();
      return;
    }
    if (value === undefined || (observed && value === previous)) return;
    observed = true;
    previous = value;
    refresh();
  };
  const unsubscribe = watch.onUpdate(update);
  update();
  // Focus and network recovery are user/environment changes, not idle polling.
  window.addEventListener('focus', refresh);
  window.addEventListener('online', refresh);
  return () => {
    unsubscribe();
    window.removeEventListener('focus', refresh);
    window.removeEventListener('online', refresh);
  };
}
