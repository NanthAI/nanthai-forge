// SPDX-License-Identifier: Apache-2.0
// Pure: runs in the Convex non-Node runtime inside the existing overlap read.
import type { OverlapEvidence } from './hosted-overlap-evidence.js';

type Change = { path: string; evidence?: OverlapEvidence };
export type SymbolNote = {
  /** This Lane's file: where its changed lines use the symbol, or where it changes the symbol. */
  file: string;
  symbol: string;
  peerFile: string;
  /** `uses`: my changed lines use a symbol the peer changes; `changes`: the reverse. */
  direction: 'uses' | 'changes';
  /** Package-level note (`ECOSYSTEM:DIR`) for code without import-level facts: `symbol` is then the
   * changed names joined (empty when the package's contract changed without a name). */
  package?: string;
  /** Package notes: the changed names, empty when the contract changed without one. */
  names?: string[];
};
// Package facts (hosted-overlap-packages): `pkg:KEY#NAME` exports and `pkg:KEY#*` refs, no file prefix.
const PACKAGE_FACT = 'pkg:';
type PackageExport = { file: string; names: Set<string> };

export function symbolFacts(changes: Change[]) {
  const exports = new Set<string>(),
    refs: [string, string][] = [],
    packages = new Map<string, PackageExport>(),
    packageRefs: [string, string][] = [];
  for (const change of [...changes].sort((a, b) => a.path.localeCompare(b.path))) {
    const links = change.evidence?.symbolLinks;
    if (!links || 'unavailable' in links) continue;
    for (const name of links.exports) {
      const at = name.lastIndexOf('#');
      if (name.startsWith(PACKAGE_FACT) && at > 0) {
        const key = name.slice(PACKAGE_FACT.length, at),
          known = packages.get(key) ?? { file: change.path, names: new Set<string>() };
        known.names.add(name.slice(at + 1));
        packages.set(key, known);
      } else exports.add(`${change.path}#${name}`);
    }
    for (const ref of links.refs) {
      const at = ref.lastIndexOf('#');
      if (ref.startsWith(PACKAGE_FACT) && at > 0)
        packageRefs.push([ref.slice(PACKAGE_FACT.length, at), change.path]);
      else refs.push([ref, change.path]);
    }
  }
  return {
    exports,
    refs: refs.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])),
    packages,
    packageRefs: packageRefs.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])),
  };
}
const packageNames = (names: Set<string>) => [...names].filter(name => name !== '*').sort();

/** At most one cross-file symbol link between two Lanes' saved changes, or null. In memory over rows
 * the overlap read already loaded: no extra reads. Missing facts never prove independence. */
export function crossFileSymbolNote(
  a: ReturnType<typeof symbolFacts>,
  b: ReturnType<typeof symbolFacts>,
): SymbolNote | null {
  for (const [ref, file] of a.refs)
    if (b.exports.has(ref)) {
      const [peerFile, symbol] = split(ref);
      return { file, symbol, peerFile, direction: 'uses' };
    }
  for (const [ref, peerFile] of b.refs)
    if (a.exports.has(ref)) {
      const [file, symbol] = split(ref);
      return { file, symbol, peerFile, direction: 'changes' };
    }
  // No import-level link: package level. Code in a package, or in one that depends on it, may use the
  // contract another Lane changes there. Names where export facts exist; otherwise the package alone.
  for (const [key, file] of a.packageRefs) {
    const hit = b.packages.get(key);
    if (hit)
      return {
        file,
        symbol: packageNames(hit.names).join(', '),
        names: packageNames(hit.names),
        peerFile: hit.file,
        direction: 'uses',
        package: key,
      };
  }
  for (const [key, peerFile] of b.packageRefs) {
    const hit = a.packages.get(key);
    if (hit)
      return {
        file: hit.file,
        symbol: packageNames(hit.names).join(', '),
        names: packageNames(hit.names),
        peerFile,
        direction: 'changes',
        package: key,
      };
  }
  return null;
}
const split = (ref: string) => {
  const at = ref.lastIndexOf('#');
  return [ref.slice(0, at), ref.slice(at + 1)] as const;
};

/** Agent-facing text. The peer is named by Lane id; actor display stays in `participants`. */
export function symbolNoteText(note: SymbolNote, peerLane: string, peerIntent: string) {
  const peer = `Lane ${peerLane} (${peerIntent.slice(0, 120)})`;
  if (note.package) {
    const names = note.names ?? [],
      what = names.length
        ? names.length > 3
          ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
          : names.join(', ')
        : 'a contract (the changed names are not known)';
    return (
      note.direction === 'uses'
        ? `advisory cross-file: your changed lines in ${note.file} may use package ${note.package}, where ${peer} changes ${what} in ${note.peerFile}.`
        : `advisory cross-file: ${peer} has changed lines in ${note.peerFile} that may use package ${note.package}, where you change ${what} in ${note.file}.`
    ).slice(0, 400);
  }
  return (
    note.direction === 'uses'
      ? `advisory cross-file: your changed lines in ${note.file} use ${note.symbol}, which ${peer} changes in ${note.peerFile}.`
      : `advisory cross-file: ${peer} has changed lines in ${note.peerFile} that use ${note.symbol}, which you change in ${note.file}.`
  ).slice(0, 400);
}
