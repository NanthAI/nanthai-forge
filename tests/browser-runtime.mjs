// SPDX-License-Identifier: Apache-2.0
export { browserExecutable } from '../scripts/check-browser-runtime.mjs';

/** Settle fonts and finite transitions before layout/contrast assertions; idle animations never finish. */
export async function settleBrowserPage(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    document.documentElement.getBoundingClientRect();
    await Promise.all(
      document
        .getAnimations()
        .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map(animation => {
          // Assert the final layout deterministically, without waiting for a headless frame clock.
          animation.finish();
          return animation.finished.catch(() => {});
        }),
    );
  });
}
