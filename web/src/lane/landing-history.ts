// SPDX-License-Identifier: Apache-2.0
import type { ConvexReactClient } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import {
  capsuleHistoryQueries,
  hasLandingCapsule,
  hasJournalHistory,
  hydrateLandingHistory,
} from '../../../src/landing-capsule-client';

const decode = (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value);
const needsProtocol = (error: unknown) => String(error).includes('CLI_UPGRADE_REQUIRED');
export async function landingHistoryQuery(
  client: ConvexReactClient,
  name: string,
  args: Record<string, unknown>,
) {
  const ref = makeFunctionReference<'query'>(name);
  let value;
  try {
    value = await client.query(ref, args);
  } catch (error) {
    if (!capsuleHistoryQueries.has(name) || !needsProtocol(error)) throw error;
    value = await client.query(ref, { ...args, capsuleProtocol: 1 });
  }
  return decode(
    await hydrateLandingHistory(name, args, value, (name, request) =>
      client.action(makeFunctionReference<'action'>(name), { ...request, projectId: args.projectId }),
    ),
  );
}

/** Register first, hydrate cold history on updates, and discard every superseded async result. */
export function watchLandingHistory(
  client: ConvexReactClient,
  name: string,
  args: Record<string, unknown>,
  changed: (value: unknown | undefined) => void,
  failed: (error: unknown) => void,
) {
  let active = true,
    generation = 0,
    stop = () => {};
  const subscribe = (protocol: boolean) => {
    const watch = client.watchQuery(makeFunctionReference<'query'>(name), {
      ...args,
      ...(protocol ? { capsuleProtocol: 1 } : {}),
    });
    const update = () => {
      const selected = ++generation;
      try {
        const value = watch.localQueryResult();
        if (value === undefined) {
          changed(undefined);
          return;
        }
        if (!hasLandingCapsule(value) && !hasJournalHistory(value)) {
          changed(decode(value));
          return;
        }
        const hydrated = hydrateLandingHistory(name, args, value, (name, request) =>
          client.action(makeFunctionReference<'action'>(name), { ...request, projectId: args.projectId }),
        );
        // Hide the preceding viewer's result while a new view is being authorized.
        changed(undefined);
        void hydrated.then(
          result => {
            if (active && selected === generation) changed(decode(result));
          },
          error => {
            if (active && selected === generation) failed(error);
          },
        );
      } catch (error) {
        changed(undefined);
        if (!protocol && capsuleHistoryQueries.has(name) && needsProtocol(error)) {
          stop();
          subscribe(true);
        } else failed(error);
      }
    };
    stop = watch.onUpdate(update);
    update();
  };
  subscribe(false);
  return () => {
    active = false;
    generation++;
    stop();
  };
}
