// SPDX-License-Identifier: Apache-2.0
/** Backend conflict evidence cannot know the caller's local checkout. The
 * transport supplies its one executable continuation with that exact root. */
export function recoveryAdviceFindings(path, source) {
  if (
    !path.startsWith('convex/') ||
    !/\b(?:COMPOSITION_CONFLICT|CONFLICT_MARKERS|RESOLUTION_REQUIRED)\b/.test(source)
  )
    return [];
  return /\bnforge\s+agent\s+(?:["'`](?:\.|ROOT)["'`]|\.|ROOT)(?=\s)/.test(source)
    ? [
        `${path}: backend conflict advice must not embed a cwd/ROOT command; retain evidence and let the transport supply its exact-root recovery command.`,
      ]
    : [];
}
