// SPDX-License-Identifier: Apache-2.0
import { readFileSync, realpathSync } from 'node:fs';
import { digest } from './hash.js';
import { readSource } from './files.js';
import { blobHasCrlf, isGitattributesPath, textAttributes, type TextAttributes } from './git-attributes.js';

/** `.gitattributes` files are read up to this size, as the GitHub mirror reads them. */
const attributeBytes = 1024 * 1024;

type Pinned = { path: string; blob: string; mode: string };
/** A State's `.gitattributes` files: a checkout ensures their blobs with the files it stages. */
export const textAttributeFiles = <T extends Pinned>(files: readonly T[]) =>
  files.filter(file => file.mode === 'file' && isGitattributesPath(file.path));
const attributeFiles = textAttributeFiles;

/** Line-ending rules of a State, read from its `.gitattributes` blobs in a verified object
 * directory; null when it has none that converts anything. Local reads of those few files only. */
export function stateText(objects: string, files: readonly Pinned[]): TextAttributes | null {
  const found = attributeFiles(files);
  if (!found.length) return null;
  const root = realpathSync(objects);
  return textAttributes(
    found.flatMap(file => {
      const bytes = readSource(root, file.blob, attributeBytes, file.blob);
      return bytes && digest(bytes) === file.blob ? [{ path: file.path, text: bytes.toString('utf8') }] : [];
    }),
  );
}

/** Line-ending rules of a checkout, from its working `.gitattributes` files at the baseline's
 * paths (Git reads the working tree's); null when none converts anything. */
export function worktreeText(root: string, files: readonly Pinned[]): TextAttributes | null {
  const found = attributeFiles(files);
  if (!found.length) return null;
  return textAttributes(
    found.flatMap(file => {
      try {
        const bytes = readSource(root, file.path, attributeBytes);
        return bytes ? [{ path: file.path, text: bytes.toString('utf8') }] : [];
      } catch {
        return [];
      }
    }),
  );
}

/** Line-ending rules of the checkout whose marker (`.forge/<name>`, holding its `state`) is at
 * `marker`; null when it is unreadable or has no converting `.gitattributes`. */
export function markerText(root: string, marker: string): TextAttributes | null {
  try {
    const value = JSON.parse(readFileSync(marker, 'utf8')) as { state?: { files?: Pinned[] } };
    return Array.isArray(value.state?.files) ? worktreeText(root, value.state.files) : null;
  } catch {
    return null;
  }
}

const converted = (mode: string | undefined) => mode !== 'symlink' && mode !== 'gitlink';

/** Whether these working bytes are this blob as Git sees it: the same bytes, or bytes Git's `add`
 * would store as the blob (a CRLF checkout of an LF blob under `eol=crlf`). Links and submodule
 * pointers are never converted. */
export function workingMatches(
  text: TextAttributes | null,
  path: string,
  bytes: Uint8Array,
  blob: string,
  mode?: string,
): boolean {
  if (digest(bytes) === blob) return true;
  const stored = converted(mode) ? text?.toGit(path, bytes, () => false) : null;
  return Boolean(stored && digest(stored) === blob);
}

/** The bytes Git's `add` stores for a working file: CRLF becomes LF for files marked text (a
 * guessed-text file keeps CRLF when its current blob, read by `baseline`, already has it).
 * Bytes equal to the current blob are kept as they are. */
export function storedBytes(
  text: TextAttributes | null,
  path: string,
  mode: string,
  bytes: Buffer,
  baseline?: { blob: string; read: () => Uint8Array | null },
): Buffer {
  if (!text || !converted(mode) || (baseline && digest(bytes) === baseline.blob)) return bytes;
  return (
    text.toGit(path, bytes, () => {
      if (!baseline) return false;
      const old = baseline.read();
      // Unknown current bytes: keep the working bytes, never guess a normalisation.
      return old ? blobHasCrlf(old) : true;
    }) ?? bytes
  );
}
