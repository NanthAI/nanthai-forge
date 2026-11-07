// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import {
  SECRET_SCAN_ALLOW_FILE,
  SECRET_ALLOW_MAX_CHANGES,
  SECRET_ALLOW_PATH_MAX,
  SECRET_ALLOW_REASON_MAX,
  type SecretAllowChange,
  type SecretAllowEvidence,
} from './secret-allow.js';

/** Landing secret scan (Issue 31f8b580). Runs inside Forge's own check executors on
 * the changed paths of the composed Candidate only. A finding names its path, line,
 * kind and a short fingerprint; the matched value never leaves this module.
 * Allow entries count only from the base (main) State (Issue 93e14bb0, R-01). */
export { SECRET_SCAN_ALLOW_FILE };
/** Files above this size are skipped; credentials live in small text files. */
export const SECRET_SCAN_MAX_FILE_BYTES = 1024 * 1024;
/** At most this many findings are reported; the count says how many more exist. */
export const SECRET_SCAN_MAX_FINDINGS = 20;

export type SecretFinding = { path: string; line: number; kind: string; fingerprint: string };
export type SecretScanResult = {
  findings: SecretFinding[];
  /** Findings beyond SECRET_SCAN_MAX_FINDINGS. */
  more: number;
  /** Findings matched by an allow entry on the base (main), by fingerprint (never the value). */
  allowed: number;
  /** Findings an allow entry added in this same change would match; they still fail. */
  selfAllowed: number;
  /** Present only when the change edits the allow file: entries added or edited against the base. */
  allowChanges?: SecretAllowEvidence;
  scannedFiles: number;
  skippedFiles: number;
};
export type SecretScanOptions = {
  /** The allow file bytes of the base (main) State, or undefined when it has none or the
   * base is unreadable. Entries in the change under check never take effect here, so a
   * change cannot allow its own finding (R-01). */
  baseAllow: Buffer | undefined;
  /** Future private-file audience (Issue 6bd7ddb1): a private path is never scanned. */
  isPrivate?: (path: string) => boolean;
};

// Known credential shapes. Prefixes are fixed by each provider; bodies are random.
const patterns: { kind: string; pattern: RegExp }[] = [
  // A header alone is a fixture or a parser; a key has a base64 body after it (raw or `\n` escaped).
  {
    kind: 'private-key',
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----(?:\r?\n|\\r?\\n)(?:[A-Za-z-]+: [^\n\\]*(?:\r?\n|\\r?\\n))*(?:\r?\n|\\r?\\n)?[A-Za-z0-9+/=]{40,}/g,
  },
  { kind: 'aws-access-key-id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { kind: 'github-token', pattern: /\bgithub_pat_[A-Za-z0-9_]{60,255}\b/g },
  { kind: 'gitlab-token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'slack-token', pattern: /\bxox[abeoprs]-(?:[0-9]+-){1,3}[A-Za-z0-9]{24,}\b/g },
  { kind: 'live-secret-key', pattern: /\b[sr]k_live_[A-Za-z0-9]{20,}\b/g },
  { kind: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'anthropic-api-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/g },
  {
    kind: 'openai-api-key',
    pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}\b/g,
  },
  { kind: 'openai-api-key', pattern: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}\b/g },
  { kind: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
];
// A secret-named assignment whose value looks random: `API_KEY=…`, `token: "…"`.
const assignment =
  /(?:secret|token|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credential)[A-Za-z0-9_-]*['"]?\s*[:=]\s*['"`]?([A-Za-z0-9+/_=-]{24,})/gi;

/** Shannon entropy in bits per character. */
export function entropy(text: string) {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}
// Placeholders (`ghp_xxxx…`, `AKIA0000…`) repeat a few characters and documented
// examples say so (`…EXAMPLE`); real bodies do neither.
const placeholder = (value: string) => entropy(value) < 3 || value.includes('EXAMPLE');
// Hex digests top out at 4 bits/char, so 4.3 keeps hashes and ids out.
const randomLooking = (value: string) =>
  entropy(value) >= 4.3 && /[0-9]/.test(value) && /[a-z]/.test(value) && /[A-Z]/.test(value);

export function secretFingerprint(path: string, kind: string, value: string) {
  return createHash('sha256')
    .update(`forge-secret-allow-v1\0${path}\0${kind}\0${value}`)
    .digest('hex')
    .slice(0, 16);
}

/** Allow entries: `{"allow":[{"fingerprint":"…","path":"…","reason":"…"}]}`. An entry
 * without a reason is ignored, so every override says why. */
export function parseSecretAllowEntries(bytes: Buffer | undefined) {
  const entries: { fingerprint: string; path: string; reason: string }[] = [];
  if (!bytes) return entries;
  try {
    const value = JSON.parse(bytes.toString('utf8')) as { allow?: unknown };
    for (const entry of Array.isArray(value.allow) ? value.allow : []) {
      const item = entry as { fingerprint?: unknown; path?: unknown; reason?: unknown };
      if (
        typeof item.fingerprint === 'string' &&
        /^[0-9a-f]{16}$/.test(item.fingerprint) &&
        typeof item.path === 'string' &&
        typeof item.reason === 'string' &&
        item.reason.trim()
      )
        entries.push({ fingerprint: item.fingerprint, path: item.path, reason: item.reason });
    }
  } catch {
    /* An unreadable allow file allows nothing. */
  }
  return entries;
}
export function parseSecretAllow(bytes: Buffer | undefined) {
  return new Set(parseSecretAllowEntries(bytes).map(entry => `${entry.path}\0${entry.fingerprint}`));
}
/** Author text bound for a receipt and an alert: one line, bounded, and withheld when it
 * holds something the scan would call a credential. */
function safeText(text: string, max: number) {
  const line = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (scanSecretText('allow-entry', line).length) return '[withheld: looks like a credential]';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function lineAt(starts: number[], index: number) {
  let low = 0,
    high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle]! <= index) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/** Findings for one file's text, in line order. */
export function scanSecretText(path: string, text: string) {
  const found: (SecretFinding & { index: number })[] = [];
  const seen = new Set<string>();
  const add = (kind: string, value: string, index: number) => {
    const key = `${index}\0${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ path, line: 0, kind, fingerprint: secretFingerprint(path, kind, value), index });
  };
  const known = new Set<number>();
  for (const { kind, pattern } of patterns)
    for (const match of text.matchAll(pattern)) {
      if (placeholder(kind === 'private-key' ? match[0].slice(-40) : match[0])) continue;
      add(kind, match[0], match.index);
      known.add(match.index);
    }
  for (const match of text.matchAll(assignment)) {
    const value = match[1]!,
      index = match.index + match[0].length - value.length;
    if (
      !randomLooking(value) ||
      placeholder(value) ||
      [...known].some(start => start >= match.index && start <= index + value.length)
    )
      continue;
    add('high-entropy-secret', value, index);
  }
  if (!found.length) return [];
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return found
    .sort((a, b) => a.index - b.index)
    .map(({ index, ...finding }) => ({ ...finding, line: lineAt(starts, index) }));
}

/** Scan the changed paths of a composed result. `read` returns a path's bytes in the
 * result, or undefined for a deleted path or a link. Allow entries come from
 * `options.baseAllow` only; the result's own allow file is read only to report what
 * the change adds (`allowChanges`, for the receipt mark and the owner alert). */
export function scanSecretPaths(
  paths: readonly string[],
  read: (path: string) => Buffer | undefined,
  options: SecretScanOptions,
): SecretScanResult {
  const baseEntries = parseSecretAllowEntries(options.baseAllow);
  const allow = new Set(baseEntries.map(entry => `${entry.path}\0${entry.fingerprint}`));
  const unique = [...new Set(paths)].sort();
  const allowFileChanged = unique.includes(SECRET_SCAN_ALLOW_FILE);
  const changeEntries = allowFileChanged ? parseSecretAllowEntries(read(SECRET_SCAN_ALLOW_FILE)) : [];
  const proposed = new Set(changeEntries.map(entry => `${entry.path}\0${entry.fingerprint}`));
  const findings: SecretFinding[] = [];
  const found = new Set<string>();
  let allowed = 0,
    selfAllowed = 0,
    scannedFiles = 0,
    skippedFiles = 0,
    total = 0;
  for (const path of unique) {
    if (path === SECRET_SCAN_ALLOW_FILE || options.isPrivate?.(path)) {
      skippedFiles++;
      continue;
    }
    const bytes = read(path);
    if (!bytes) continue;
    // Large and binary files are skipped: NUL in the first 8 KiB marks binary.
    if (bytes.length > SECRET_SCAN_MAX_FILE_BYTES || bytes.subarray(0, 8192).includes(0)) {
      skippedFiles++;
      continue;
    }
    scannedFiles++;
    for (const finding of scanSecretText(path, bytes.toString('utf8'))) {
      const key = `${path}\0${finding.fingerprint}`;
      if (allow.has(key)) {
        allowed++;
        continue;
      }
      found.add(key);
      if (proposed.has(key)) selfAllowed++;
      total++;
      if (findings.length < SECRET_SCAN_MAX_FINDINGS) findings.push(finding);
    }
  }
  const result: SecretScanResult = {
    findings,
    more: total - findings.length,
    allowed,
    selfAllowed,
    scannedFiles,
    skippedFiles,
  };
  if (allowFileChanged) result.allowChanges = allowChanges(baseEntries, changeEntries, found);
  return result;
}

/** Entries of the change's allow file that the base lacks, or holds with another reason. */
function allowChanges(
  base: readonly { fingerprint: string; path: string; reason: string }[],
  change: readonly { fingerprint: string; path: string; reason: string }[],
  found: ReadonlySet<string>,
): SecretAllowEvidence {
  const reasons = new Map<string, Set<string>>();
  for (const entry of base) {
    const key = `${entry.path}\0${entry.fingerprint}`;
    reasons.set(key, (reasons.get(key) ?? new Set()).add(entry.reason));
  }
  const entries: SecretAllowChange[] = [];
  const seen = new Set<string>();
  let more = 0;
  for (const entry of change) {
    const key = `${entry.path}\0${entry.fingerprint}`;
    const identity = `${key}\0${entry.reason}`;
    if (reasons.get(key)?.has(entry.reason) || seen.has(identity)) continue;
    seen.add(identity);
    if (entries.length >= SECRET_ALLOW_MAX_CHANGES) {
      more++;
      continue;
    }
    entries.push({
      path: safeText(entry.path, SECRET_ALLOW_PATH_MAX) || '[empty path]',
      fingerprint: entry.fingerprint,
      reason: safeText(entry.reason, SECRET_ALLOW_REASON_MAX) || '[empty reason]',
      change: reasons.has(key) ? 'edited' : 'added',
      sameLanding: found.has(key),
    });
  }
  return { entries, more };
}

type StateFile = { path: string; blob: string; mode: string };
/** Paths whose bytes or mode differ from the base State; no base means every path. */
export function changedStatePaths(before: readonly StateFile[] | null, after: readonly StateFile[]) {
  if (!before) return after.map(file => file.path);
  const base = new Map(before.map(file => [file.path, file]));
  return after
    .filter(file => base.get(file.path)?.blob !== file.blob || base.get(file.path)?.mode !== file.mode)
    .map(file => file.path);
}

/** Value-free notice lines. The last, an `Error:` line, is the one a landing failure
 * shows (src/hosted-landing-suspect.ts picks it); it avoids `key: value` shapes that
 * the failure text scrubber would redact. Remove-and-rotate comes first: an allow entry
 * is for a false positive and counts only once it is on main, so it needs its own landing. */
export function secretScanNotice(
  result: Pick<SecretScanResult, 'findings' | 'more'> & { selfAllowed?: number | undefined },
) {
  const listed = result.findings
    .map(item => `${item.path}:${item.line} ${item.kind} (fingerprint ${item.fingerprint})`)
    .join('; ');
  const more = result.more ? `; +${result.more} more` : '';
  return [
    ...result.findings.map(
      item => `secret-scan: ${item.path}:${item.line} ${item.kind} (fingerprint ${item.fingerprint})`,
    ),
    'secret-scan: remove the credential from this change and rotate it at its provider; once it reached a Lane save it may be retained.',
    `secret-scan: only if it is not a secret, add {"fingerprint","path","reason"} to ${SECRET_SCAN_ALLOW_FILE} in its own landing first. Allow entries count only once they are on main, and project owners are alerted.`,
    ...(result.selfAllowed
      ? [
          `secret-scan: ${result.selfAllowed} finding(s) match an allow entry added in this same change; that entry does not count until it lands on its own.`,
        ]
      : []),
    `SecretScanError: committed credential found in ${listed}${more}. Remove and rotate it first; an allow entry for a false positive needs its own landing.`,
  ];
}

/** A Node command that prints the notice and fails, so the run fails like any check. */
export function secretScanFailureCommand(
  executable: string,
  result: Pick<SecretScanResult, 'findings' | 'more'> & { selfAllowed?: number | undefined },
) {
  return [
    executable,
    '--eval',
    `for (const line of ${JSON.stringify(secretScanNotice(result))}) console.error(line); process.exitCode = 1;`,
  ];
}
