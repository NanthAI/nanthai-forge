// SPDX-License-Identifier: Apache-2.0
import { posix } from 'node:path';
import { globPattern } from './autonomy-policy.js';
import {
  CODE_FILE,
  diffExports,
  scanExports,
  scanImports,
  type ContractChange,
  type ImportRef,
} from './contract-exports.js';
import { ForgeError } from './errors.js';
import { STRUCTURAL_CONTRACT_FILE, structuralExports } from './contract-structural.js';

export type { ContractChange } from './contract-exports.js';
type FileRef = { path: string; blob: string };
export type ContractSource = { object(blob: string): Buffer };
const MAX_BYTES = 512 * 1024,
  MAX_CHANGES = 200,
  MAX_BARREL_READS = 40;
const imports = new Map<string, ImportRef[]>();
const text = (source: ContractSource, blob: string) => {
  const bytes = source.object(blob);
  return bytes.length > MAX_BYTES ? undefined : bytes.toString('utf8');
};
/** Where the contracts config lives: `contracts` in the root `forge.json` (captured like any source
 * file), else the older `.forge/contracts.json`, which a save never captures and so is read only from a
 * State that already holds it. `{"interfaces":["glob"]}` declares extra interface files whose whole
 * content is the contract. `numbers` and `generated` are not interpreted. */
export const CONTRACTS_CONFIG = 'forge.json',
  LEGACY_CONTRACTS_CONFIG = '.forge/contracts.json';
function contractsConfig(source: ContractSource, files: FileRef[]): { interfaces?: unknown } | undefined {
  const parse = (path: string) => {
    const file = files.find(item => item.path === path);
    if (!file) return undefined;
    try {
      const parsed = JSON.parse(text(source, file.blob) ?? '') as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };
  const neutral = parse(CONTRACTS_CONFIG)?.contracts;
  return neutral && typeof neutral === 'object'
    ? (neutral as { interfaces?: unknown })
    : parse(LEGACY_CONTRACTS_CONFIG);
}
export function declaredInterfaces(
  source: ContractSource,
  files: FileRef[],
): ((path: string) => boolean) | undefined {
  const parsed = contractsConfig(source, files);
  if (!parsed) return undefined;
  const patterns = (Array.isArray(parsed.interfaces) ? parsed.interfaces : [])
    .filter((item): item is string => typeof item === 'string')
    .flatMap(glob => {
      try {
        return [globPattern(glob)];
      } catch {
        return [];
      }
    });
  return patterns.length ? path => patterns.some(pattern => pattern.test(path)) : undefined;
}
/** Added, removed and changed exported declarations between two file lists. Only files
 * whose blob changed are read; unchanged and non-code files cost one map lookup. */
export function contractDelta(source: ContractSource, before: FileRef[], after: FileRef[]): ContractChange[] {
  const old = new Map(before.map(file => [file.path, file.blob])),
    now = new Map(after.map(file => [file.path, file.blob]));
  const declared = declaredInterfaces(source, after);
  const out: ContractChange[] = [];
  for (const path of [...new Set([...old.keys(), ...now.keys()])].sort()) {
    const a = old.get(path),
      b = now.get(path);
    if (a === b) continue;
    const code = CODE_FILE.test(path),
      structural = !code && STRUCTURAL_CONTRACT_FILE.test(path);
    if (!code && !structural && !declared?.(path)) continue;
    if (code || structural) {
      const from = a ? text(source, a) : undefined,
        to = b ? text(source, b) : undefined;
      if ((a && from === undefined) || (b && to === undefined)) continue;
      const scan = (body: string | undefined, key: string | undefined) =>
        body === undefined ? undefined : code ? scanExports(body, key) : structuralExports(path, body, key);
      const before = scan(from, a),
        after = scan(to, b);
      // Python, Java or Rust without facts (a syntax error): the whole file's contract may have changed.
      if (structural && ((from !== undefined && !before) || (to !== undefined && !after)))
        out.push({ file: path, export: '*', kind: !a ? 'added' : !b ? 'removed' : 'changed' });
      else out.push(...diffExports(path, before, after));
    } else out.push({ file: path, export: '*', kind: !a ? 'added' : !b ? 'removed' : 'changed' });
    if (out.length >= MAX_CHANGES) return out.slice(0, MAX_CHANGES);
  }
  return out;
}
function resolveSpec(from: string, spec: string): string[] {
  if (!spec.startsWith('.')) return [];
  const base = posix.normalize(posix.join(posix.dirname(from), spec)).replace(/^\.\//, '');
  const stem = base.replace(/\.(?:[cm]?js|jsx)$/, '');
  const exts = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
  return [base, ...exts.map(ext => stem + ext), ...exts.map(ext => `${base}/index${ext}`)];
}
const importsOf = (source: ContractSource, file: FileRef) => {
  let known = imports.get(file.blob);
  if (!known) {
    const body = text(source, file.blob);
    known = body === undefined ? [] : scanImports(body);
    if (imports.size > 4000) imports.clear();
    imports.set(file.blob, known);
  }
  return known;
};
const reaches = (names: string[] | '*', change: ContractChange) =>
  names === '*' ||
  change.export === '*' ||
  names.includes(change.export) ||
  change.export.startsWith('*:') ||
  change.export.startsWith('table:');
/** The subset of `delta` that `importers` use: named imports of a changed export,
 * namespace/dynamic/side-effect imports of a changed file, or one barrel hop. */
export function dependentOn(
  source: ContractSource,
  importers: FileRef[],
  everything: FileRef[],
  delta: ContractChange[],
): ContractChange[] {
  if (!delta.length) return [];
  const byFile = new Map<string, ContractChange[]>();
  for (const change of delta) byFile.set(change.file, [...(byFile.get(change.file) ?? []), change]);
  const hit = new Set<ContractChange>();
  let index: Map<string, FileRef> | undefined,
    reads = 0;
  for (const importer of importers) {
    if (!CODE_FILE.test(importer.path)) continue;
    for (const ref of importsOf(source, importer)) {
      for (const candidate of resolveSpec(importer.path, ref.spec)) {
        const direct = byFile.get(candidate);
        if (direct) {
          for (const change of direct) if (reaches(ref.names, change)) hit.add(change);
          break;
        }
        index ??= new Map(everything.map(file => [file.path, file]));
        const barrel = index.get(candidate);
        if (!barrel || !CODE_FILE.test(barrel.path)) continue;
        if (reads++ >= MAX_BARREL_READS) break;
        for (const inner of importsOf(source, barrel))
          for (const target of resolveSpec(barrel.path, inner.spec))
            for (const change of byFile.get(target) ?? [])
              if (reaches(inner.names, change) && reaches(ref.names, change)) hit.add(change);
        break;
      }
    }
  }
  return [...hit].sort((a, b) =>
    a.file === b.file ? (a.export < b.export ? -1 : 1) : a.file < b.file ? -1 : 1,
  );
}
export class ContractResyncError extends ForgeError {
  constructor(
    readonly changes: ContractChange[],
    readonly head: string,
  ) {
    super(
      'CONTRACT_RESYNC_REQUIRED',
      `Main changed contracts this change uses: ${changes
        .slice(0, 5)
        .map(item => `${item.file} ${item.export} ${item.kind}`)
        .join(
          '; ',
        )}${changes.length > 5 ? `; +${changes.length - 5} more` : ''}. Sync main, then recheck; finish does this automatically.`,
    );
  }
}
