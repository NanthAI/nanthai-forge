// SPDX-License-Identifier: Apache-2.0
import { REGISTRY, queueProofPaths } from '../scripts/core-queue-paths.mjs';
import { assertQueueProof } from '../scripts/test-queue-proof.mjs';
import { scrubText } from './client-error-text.js';
import { STANDARD_CHECK_ENTRY } from './standard-check.js';
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

const equal = (a: NativeFile | undefined, b: NativeFile | undefined) =>
  a?.blob === b?.blob && a?.mode === b?.mode;

/** Preview hosted checks from verified saved inputs and observed main. Diverging paths and
 * unreadable inputs are left to the hosted check, which judges the composed Candidate. */
export function reportPreflightChecks(
  reads: LocalReads,
  root: string,
  changed: readonly string[] | undefined,
  saved: readonly NativeFile[],
  baseHead: string,
  mainHead: string | undefined,
) {
  if (!mainHead || changed?.length === 0) return {};
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
    if (!main || !base) return {};
    const paths = changed ?? reads.changedStatePaths(base, saved);
    if (!paths.length) return {};
    const selected = new Set(paths);
    selected.add(reads.allowFile);
    selected.add(REGISTRY);
    selected.add(STANDARD_CHECK_ENTRY);
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
    const queueProof = previewQueueProof(paths, before, after, current, read, deadline);
    const preview = queueProof ? { queueProof: { main: mainHead, ...queueProof } } : {};
    const allow = current.get(reads.allowFile);
    const baseAllow = allow && allow.mode !== 'symlink' ? read(allow) : undefined;
    if (allow && allow.mode !== 'symlink' && !baseAllow) return preview;
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
    if (!scan.findings.length) return preview;
    const findings = scan.findings.slice(0, 5);
    const more = scan.more + scan.findings.length - findings.length;
    const listed = findings.map(f => `${JSON.stringify(f.path)}:${f.line} ${f.kind} (${f.fingerprint})`);
    process.stderr.write(
      `preflight: the hosted secret scanner found ${findings.length + more} issue(s) in saved Lane files: ${listed.join(', ')}${more ? ` and ${more} more` : ''}. The hosted check scans the composed Candidate.\n`,
    );
    return {
      ...preview,
      secretScan: {
        main: mainHead,
        findings,
        more,
        ...(scan.selfAllowed ? { selfAllowed: scan.selfAllowed } : {}),
      },
    };
  } catch {
    return {};
  }
}

/** Only paths this Lane would change on main. A divergent proof, registry or source
 * can affect the verdict, so leave that comparison to the Candidate check. */
function previewQueueProof(
  paths: readonly string[],
  before: Map<string, NativeFile>,
  after: Map<string, NativeFile>,
  main: Map<string, NativeFile>,
  read: (file: NativeFile) => Buffer | undefined,
  deadline: number,
) {
  // This is the checkout signature of the standard Forge recipe. Actual check
  // selection is hosted; a custom command can ignore this advisory.
  if (!after.has(STANDARD_CHECK_ENTRY)) return undefined;
  const changed = queueProofPaths(paths.filter(path => !equal(after.get(path), main.get(path))));
  if (!changed) return undefined;
  const candidate = (path: string) => {
    if (performance.now() >= deadline) throw new Error();
    const base = before.get(path);
    const saved = after.get(path);
    const current = main.get(path);
    if (equal(base, saved)) return current;
    if (equal(base, current) || equal(saved, current)) return saved;
    throw new Error();
  };
  try {
    for (const path of changed.source) candidate(path);
    for (const path of changed.receipts) candidate(path);
    assertQueueProof(changed, {
      readText: path => {
        const file = candidate(path);
        if (!file && path !== REGISTRY) return 'null';
        if (!file) throw new Error();
        if (file.mode === 'symlink') throw new Error();
        const bytes = read(file);
        if (!bytes) throw new Error();
        return bytes.toString('utf8');
      },
      digest: path => candidate(path)?.blob ?? null,
    });
  } catch (error) {
    const code = 'QUEUE_PROOF_REQUIRED';
    if (!(error instanceof Error) || !error.message.startsWith(code + ': ')) return undefined;
    const message = scrubText(error.message.replace(/\s+/g, ' '), 500);
    process.stderr.write(`preflight: ${message} The hosted check judges the composed Candidate.\n`);
    return { code, message };
  }
  return undefined;
}
