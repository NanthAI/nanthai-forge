import { routeSearch, routeUrlState } from '../shell/location';
// SPDX-License-Identifier: Apache-2.0
import { navigate } from '../ui/navigation';
import { useEffect, useState } from 'react';

/**
 * After "Create & hand to an agent": waits for the new Intent to appear in recorded Work (creation
 * returns no id), then opens it. Matching is by outcome among Intents created in the last minutes.
 */
export function useCreatedIntent(
  intents: readonly { id: string; outcome: string; createdAt?: string }[],
  open: (intentId: string) => void,
) {
  const [pending, setPending] = useState<{ outcome: string; since: number } | null>(null);
  useEffect(() => {
    if (!pending) return;
    const found = intents
      .filter(
        intent =>
          intent.outcome === pending.outcome &&
          (!intent.createdAt || Date.parse(intent.createdAt) >= pending.since),
      )
      .at(-1);
    if (!found) return;
    setPending(null);
    open(found.id);
  }, [intents, pending, open]);
  return (outcome: string) => setPending({ outcome, since: Date.now() - 5 * 60_000 });
}

/** Navigates within the app and lets every URL-driven view update. */
export function go(href: string) {
  navigate(href);
}

/** `?delegate=1` opens the hand-off sheet once, right after the Intent was created for it. */
export const delegateRequested = () =>
  typeof location !== 'undefined' && new URLSearchParams(routeSearch()).get('delegate') === '1';
export const clearDelegate = () => {
  const url = routeUrlState();
  if (!url.searchParams.has('delegate')) return;
  url.searchParams.delete('delegate');
  history.replaceState(history.state, '', url);
};
