// SPDX-License-Identifier: Apache-2.0
import type { ProfilerOnRenderCallback } from 'react';
/** Opt-in React timing for the signed-in performance harness; no source text is recorded. */
export const profileDiff: ProfilerOnRenderCallback = (id, phase, actualDuration) => {
  if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('forge-diff-profile') === '1') {
    const end = performance.now();
    performance.measure('forge:diff-render', {
      start: end - actualDuration,
      end,
      detail: { id, phase, actualDuration },
    });
  }
};
