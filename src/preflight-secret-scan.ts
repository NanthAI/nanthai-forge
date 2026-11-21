// SPDX-License-Identifier: Apache-2.0
import type { readSource } from './files.js';
import type { NativeFile } from './state/format.js';
import type { changedStatePaths, scanSecretPaths } from './secret-scan.js';

type LocalReads = {
  objects: (root: string, maxBytes?: number) => (id: string) => Buffer | null;
  digest: (bytes: Uint8Array) => string;
  files: (state: Buffer) => readonly NativeFile[];
  readSource: typeof readSource;
  changedStatePaths: typeof changedStatePaths;
  scanSecretPaths: typeof scanSecretPaths;
  allowFile: string;
  maxFileBytes: number;
};

/** Preview the hosted scan where a Lane's saved bytes can be compared with observed main.
 * A path edited on both sides may compose to different bytes, so leave it to the hosted check.
 * Missing local bytes cost coverage. No findings here never certify a Candidate. */
export function reportPreflightSecretScan(
  reads: LocalReads,
  root: string,
  changed: readonly string[] | undefined,
  saved: readonly NativeFile[],
  baseHead: string,
  mainHead: string | undefined,
) {
  if (!mainHead || changed?.length === 0) return undefined;
  const deadline = performance.now() + 150;
  const localState = reads.objects(root);
  const localBlob = reads.objects(root, reads.maxFileBytes);
  const load = (head: string) => {
    const bytes = localState(head);
    return bytes ? reads.files(bytes) : undefined;
  };
  try {
    const main = load(mainHead);
    const base = baseHead === mainHead ? main : load(baseHead);
    if (!main || !base) return undefined;
    const paths = changed ?? reads.changedStatePaths(base, saved);
    if (!paths.length) return undefined;
    const selected = new Set(paths);
    selected.add(reads.allowFile);
    const index = (files: readonly NativeFile[]) =>
      new Map(files.filter(file => selected.has(file.path)).map(file => [file.path, file]));
    const current = index(main);
    const before = base === main ? current : index(base);
    const after = index(saved);
    // A saved blob is authoritative even if the checkout has newer edits. Use the working
    // copy only when its exact bytes match the manifest (EOL-converted copies use the cache).
    const read = (file: NativeFile) => {
      try {
        const bytes = reads.readSource(root, file.path, reads.maxFileBytes, file.blob);
        if (bytes && reads.digest(bytes) === file.blob) return bytes;
      } catch {
        /* Unreadable or too large locally. Try the saved object. */
      }
      return localBlob(file.blob) ?? undefined;
    };
    const allow = current.get(reads.allowFile);
    const baseAllow = allow && allow.mode !== 'symlink' ? read(allow) : undefined;
    if (allow && allow.mode !== 'symlink' && !baseAllow) return undefined;
    const equal = (a: NativeFile | undefined, b: NativeFile | undefined) =>
      a?.blob === b?.blob && a?.mode === b?.mode;
    const scan = reads.scanSecretPaths(
      paths,
      path => {
        if (performance.now() >= deadline) return undefined;
        const file = after.get(path);
        const onMain = current.get(path);
        if (!file || file.mode === 'symlink' || equal(file, onMain) || !equal(before.get(path), onMain))
          return undefined;
        return read(file);
      },
      { baseAllow },
    );
    if (!scan.findings.length) return undefined;
    const findings = scan.findings.slice(0, 5);
    const more = scan.more + scan.findings.length - findings.length;
    const listed = findings.map(f => `${JSON.stringify(f.path)}:${f.line} ${f.kind} (${f.fingerprint})`);
    process.stderr.write(
      `preflight: the hosted secret scanner found ${findings.length + more} issue(s) in saved Lane files: ${listed.join(', ')}${more ? ` and ${more} more` : ''}. The hosted check scans the composed Candidate.\n`,
    );
    return { main: mainHead, findings, more, ...(scan.selfAllowed ? { selfAllowed: scan.selfAllowed } : {}) };
  } catch {
    // This local preview is best effort. The hosted scanner still evaluates the Candidate.
    return undefined;
  }
}
