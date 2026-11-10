// SPDX-License-Identifier: Apache-2.0
/** Overlap answers were removed with path notices (flip 4, Issue 853fcde3). Installed CLIs that still
 * call the old ack, peer-ack, overlap-acks or overlap-answers endpoints get this upgrade step. */
export const OVERLAP_ANSWERS_RETIRED =
  'Overlap notices and answers were removed: every save now trial-merges your saved files and reports a real conflict as conflictNotice, with nothing to answer. Upgrade nforge to the release that matches this deployment (reinstall @nanthai/forge from the same source); do not retry ack, peer-ack, overlap-acks or overlap-answers.';
