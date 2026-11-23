// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** Runs one action handler with Date.now held at the instant it starts.
 * Convex actions here stop at a step count or a Date.now window, whichever comes first. A loaded
 * runner hits the window sooner, so call and read counts measured machine speed rather than work
 * (4a83a41f, friction af056ee6). Holding the clock lets the step count alone bound each action;
 * measure an action's duration with performance.now, which this leaves untouched. */
export async function atOneInstant(run) {
  const previous = Date.now,
    instant = previous();
  Date.now = () => instant;
  try {
    return await run();
  } finally {
    Date.now = previous;
  }
}
