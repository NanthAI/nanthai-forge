// SPDX-License-Identifier: Apache-2.0
/** Drafts register only while actual user input is unsaved. Network activity is never a draft. */
export const drafts = new Map<symbol, () => void>();
let confirmNavigation: ((action: () => void) => void) | undefined;
export function setNavigationConfirmation(confirm?: (action: () => void) => void) {
  confirmNavigation = confirm;
}
export function requestNavigation(action: () => void) {
  if (drafts.size && confirmNavigation) confirmNavigation(action);
  else action();
}
export function navigate(href: string | URL) {
  requestNavigation(() => {
    history.pushState(null, '', href);
    dispatchEvent(new PopStateEvent('popstate'));
    scrollTo({ top: 0 });
  });
}
