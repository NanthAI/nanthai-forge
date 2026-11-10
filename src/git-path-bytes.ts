// SPDX-License-Identifier: Apache-2.0
import { ForgeError } from './errors.js';

/** Git allows any path bytes except NUL and `/`; Forge stores UTF-8 paths only (Issue 6a0dd2e8).
 * A path that is not UTF-8 is refused by name, never rewritten (a lossy decode would give the
 * Candidate check, the mirror and every checkout a different file than the repository has).
 * Byte-preserving support is planned separately. */
const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Path bytes as shown in an error: UTF-8 runs as text, any other byte as `\xNN`. */
export function shownGitPath(bytes: Uint8Array): string {
  let out = '';
  for (let at = 0; at < bytes.length;) {
    let end = at;
    // Take the longest valid prefix one byte at a time from `at`; a stray byte stands alone.
    for (let next = Math.min(bytes.length, at + 4); next > at; next--)
      try {
        strict.decode(bytes.subarray(at, next));
        end = next;
        break;
      } catch {
        /* Shorter. */
      }
    if (end === at) out += `\\x${bytes[at++]!.toString(16).toUpperCase().padStart(2, '0')}`;
    else {
      out += strict.decode(bytes.subarray(at, end));
      at = end;
    }
  }
  return out;
}

const refusal = (shown: readonly string[], source: string) =>
  new ForgeError(
    'GITHUB_SOURCE_UNSUPPORTED',
    `${source} has ${shown.length} path${shown.length === 1 ? '' : 's'} that ${shown.length === 1 ? 'is' : 'are'} not valid UTF-8: ${shown.slice(0, 20).join(', ')}${shown.length > 20 ? `, … (${shown.length - 20} more)` : ''}. Forge stores UTF-8 paths only and never renames a path silently. Rename ${shown.length === 1 ? 'it in Git to a UTF-8 name' : 'them in Git to UTF-8 names'} (git mv), push, then retry. Main was not changed.`,
  );

/** A Git path's bytes as text, or a named refusal when they are not UTF-8. */
export function gitPathText(bytes: Uint8Array, source = 'This repository'): string {
  try {
    return strict.decode(bytes);
  } catch {
    throw refusal([shownGitPath(bytes)], source);
  }
}

/** GitHub's API reports a path whose bytes are not UTF-8 with U+FFFD in their place, so such a
 * path cannot be told from its bytes there. Every listed path that holds U+FFFD is refused by
 * name, all at once (U+FFFD is shown as `�`). */
export function refuseLossyGitPaths(paths: Iterable<string>, source = 'This repository') {
  const lossy: string[] = [];
  for (const path of paths) if (path.includes('�')) lossy.push(path.replaceAll('�', '\\uFFFD'));
  if (lossy.length) throw refusal(lossy, source);
}
