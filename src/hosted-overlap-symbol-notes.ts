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
};

export function symbolFacts(changes: Change[]) {
  const exports = new Set<string>(),
    refs: [string, string][] = [];
  for (const change of changes) {
    const links = change.evidence?.symbolLinks;
    if (!links || 'unavailable' in links) continue;
    for (const name of links.exports) exports.add(`${change.path}#${name}`);
    for (const ref of links.refs) refs.push([ref, change.path]);
  }
  return { exports, refs: refs.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])) };
}

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
  return null;
}
const split = (ref: string) => {
  const at = ref.lastIndexOf('#');
  return [ref.slice(0, at), ref.slice(at + 1)] as const;
};

/** Agent-facing text. The peer is named by Lane id; actor display stays in `participants`. */
export function symbolNoteText(note: SymbolNote, peerLane: string, peerIntent: string) {
  const peer = `Lane ${peerLane} (${peerIntent.slice(0, 120)})`;
  return (
    note.direction === 'uses'
      ? `advisory cross-file: your changed lines in ${note.file} use ${note.symbol}, which ${peer} changes in ${note.peerFile}. No answer needed.`
      : `advisory cross-file: ${peer} has changed lines in ${note.peerFile} that use ${note.symbol}, which you change in ${note.file}. No answer needed.`
  ).slice(0, 400);
}
