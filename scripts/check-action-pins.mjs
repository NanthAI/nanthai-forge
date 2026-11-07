// SPDX-License-Identifier: Apache-2.0
// Workflow steps run third-party code with the job's token and permissions. A tag can move, a commit
// cannot: every `uses:` names a full commit SHA and keeps the tag it was taken from in a comment, so
// an upgrade is a reviewed edit of both. Local actions (`./path`) are part of the checkout itself;
// container actions pin an image digest.
const usesLine = /^\s*(?:-\s+)?uses:\s*(['"]?)([^'"\s#]+)\1\s*(#.*)?$/;
const pinned = /^[\w.-]+\/[\w.-]+(?:\/[^@\s]+)?@[0-9a-f]{40}$/;
const tagComment = /^#\s*v?\d[\w.-]*\s*$/;
const digest = /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/;

export const isWorkflowPath = path => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path);

/** Findings for one workflow text; `path` only labels them (locations, never source). */
export function actionPinFindings(path, text) {
  return text.split(/\r?\n/).flatMap((line, index) => {
    const match = usesLine.exec(line);
    if (!match) return [];
    const [, , target, comment] = match;
    if (target.startsWith('./') || digest.test(target)) return [];
    const where = `${path}:${index + 1}`;
    if (!pinned.test(target))
      return [`${where}: pin the action to a full commit SHA (uses: owner/repo@SHA # vN)`];
    if (!comment || !tagComment.test(comment)) return [`${where}: name the pinned tag in a comment (# vN)`];
    return [];
  });
}
