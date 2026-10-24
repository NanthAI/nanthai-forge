// SPDX-License-Identifier: Apache-2.0
/** Explicit ref/access rejections establish non-execution, independently of transience. */
export function gitPushRejectionClass(detail: string): string | undefined {
  if (/without\s+['"`]?workflow['"`]?\s+scope/i.test(detail)) return 'workflow-scope';
  if (/protected (?:branch|ref)|GH006|GH013|repository rule violations/i.test(detail)) return 'ref-policy';
  if (
    /invalid ref(?:name|spec|erence)?|not a valid ref|funny refname|deny updating a hidden ref|ref name[^\n]*(?:invalid|not allowed)/i.test(
      detail,
    )
  )
    return 'ref-name';
  if (
    /!\s*\[(?:remote )?rejected\]|\bremote rejected\b|pre-receive hook declined|non-fast-forward|fetch first|stale info/i.test(
      detail,
    )
  )
    return 'ref-rejected';
  if (
    /authentication failed|could not read (?:username|password)|repository not found|permission[^\n]*denied|write access[^\n]*not granted|access denied|not authorized|invalid credentials|bad credentials/i.test(
      detail,
    )
  )
    return 'access-rejected';
  return undefined;
}
