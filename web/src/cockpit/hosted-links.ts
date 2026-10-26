// SPDX-License-Identifier: Apache-2.0
import { cleanUrl, routeUrlState } from '../shell/location';

/** Hosted project URL that keeps the selected project and opens one of its existing pages. */
export function hostedHref(params: Record<string, string>): string {
  const url = routeUrlState();
  for (const key of [
    'projectTab',
    'intent',
    'intentTab',
    'lane',
    'session',
    'reviewView',
    'checkRun',
    'viewId',
    'decision',
    'planningItem',
    'classic',
    'delegate',
  ])
    url.searchParams.delete(key);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return cleanUrl(url);
}
