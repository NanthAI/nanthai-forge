// SPDX-License-Identifier: Apache-2.0
// Memoize module loading only; live project data always remains in Convex subscriptions.
let code: ReturnType<typeof importCode> | undefined;
const importCode = () => import('./HostedCode');
export const loadCode = () =>
  (code ??= importCode().catch(error => {
    code = undefined;
    throw error;
  }));
export function preloadDestination(tab: string) {
  if (tab === 'code') void loadCode().catch(() => {});
  if (tab === 'intents' || tab === 'work') void import('./views/HostedView').catch(() => {});
}
