// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { browserExecutable } from '../scripts/check-browser-runtime.mjs';
export { browserExecutable };

/** Use the runner override for both availability and launch. Otherwise keep Playwright's default launch. */
export function chromiumLaunchOptions(t, options) {
  const executablePath = browserExecutable(t, options);
  if (!executablePath) return null;
  return { executablePath: (options?.env ?? process.env).FORGE_UI_BROWSER || undefined };
}

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
