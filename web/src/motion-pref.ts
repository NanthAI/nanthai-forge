// SPDX-License-Identifier: Apache-2.0
// A person's opt-in to full motion of the Forge mark over the device's reduced-motion setting (DESIGN.md "Motion
// rules"; set in Settings → You). Kept in this browser only; the product never opts in for them. mark.css follows the
// device setting by itself and reads `.mk-motion-full` on the root.
const key = 'forge.motion';

export function motionFull() {
  try {
    return localStorage.getItem(key) === 'full';
  } catch {
    return false;
  }
}

export function applyMotion(full = motionFull()) {
  try {
    if (full) localStorage.setItem(key, 'full');
    else localStorage.removeItem(key);
  } catch {
    // Storage refused: the choice holds for this page only.
  }
  document.documentElement.classList.toggle('mk-motion-full', full);
}
