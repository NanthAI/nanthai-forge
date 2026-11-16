// SPDX-License-Identifier: Apache-2.0
/** Key read by the inline script in web/index.html: a browser that last had a session opens the app, not the public page. */
export const signedInHintKey = 'forge-signed-in';

/** Record whether this browser has a session. Holds no identity, only "1"; storage failures are ignored. */
export function signedInHint(signedIn: boolean) {
  try {
    if (signedIn) localStorage.setItem(signedInHintKey, '1');
    else localStorage.removeItem(signedInHintKey);
  } catch {
    // Private windows can refuse storage; the public page then shows its Sign in link.
  }
}
