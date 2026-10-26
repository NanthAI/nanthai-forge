// SPDX-License-Identifier: Apache-2.0
/** Transport details stay available on hover; drafts remain available for recovery. */
export function feedbackError(error: string, write = false): string {
  const network = /fetch|network|offline|connection|timeout|timed out/i.test(error);
  return /unknown|not sure|may have|did not return success/i.test(error) || (write && network)
    ? 'Not sure this was saved. Your text is kept; check before sending again.'
    : "Couldn't reach Forge. Your text is kept — try again.";
}
