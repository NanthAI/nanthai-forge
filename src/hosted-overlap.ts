// SPDX-License-Identifier: Apache-2.0
import { classifyOverlap, type OverlapEvidence, type OverlapClass } from './hosted-overlap-evidence.js';
import { crossFileSymbolNote, symbolFacts, symbolNoteText } from './hosted-overlap-symbol-notes.js';
import { digest } from './portable-hash.js';
import { agentActor } from './agent-slug.js';

export const OVERLAP_METADATA_BYTES = 128 * 1024;
/** Advisory notices from open Lanes idle longer than this collapse into one summary line per read. */
export const IDLE_NOTICE_MS = 6 * 3_600_000;
/** Cross-file symbol facts per Lane row, inside the row budget (replay max 9.5 KB). */
export const SYMBOL_LINK_BYTES = 16 * 1024;
/** Overlap answers (what one builder answered on an overlap notice) stay readable this long after
 * they were written, whether their Lanes landed, were abandoned or are still open. Owner decision
 * 2026-11-06 (Issue b78ca196): 90 days, the same as the board evidence value. Older rows are deleted
 * in small batches by the next answer write; no cron, no polling. */
export const OVERLAP_ANSWER_RETENTION_MS = 90 * 24 * 3_600_000;
/** Expired answer rows (and answer batch records) deleted per answer write. */
export const OVERLAP_ANSWER_CLEANUP_BATCH = 10;
/** `overlap-answers` read: rows per page (default, max), reply bytes a page may reach (limit 64 KB),
 * DB bytes a page may read (limit 1 MB) and the answer text shown per row (longer text is cut and flagged). */
export const OVERLAP_ANSWERS_DEFAULT_LIMIT = 20;
export const OVERLAP_ANSWERS_MAX_LIMIT = 50;
export const OVERLAP_ANSWERS_OUTPUT_BYTES = 56 * 1024;
export const OVERLAP_ANSWERS_READ_BYTES = 800 * 1024;
export const OVERLAP_ANSWER_TEXT_CHARS = 4_000;
export type OverlapFile = { blob: string; mode: string } | null;
export type OverlapChange = {
  path: string;
  before: OverlapFile;
  after: OverlapFile;
  evidence?: OverlapEvidence;
};
export type OverlapLane = {
  laneId: string;
  intentId: string;
  intent: string;
  actor: string;
  /** The Lane's agent session slug (c29d0780): participants then read `ACCOUNT/slug`. */
  agent?: string;
  head: string;
  baseHead: string;
  baseSequence: number | null;
  open: boolean;
  /** Exact source being resolved; shared by the origin and its resolution siblings. */
  resolutionLeft?: string;
  changes: string;
  complete: boolean;
  /** Last Lane record write (ms), or the presence time of a row older than that field. */
  lastActivityAt?: number;
  presenceRow?: { at: number };
  /** Set when a Lane of the same Intent landed after this Lane went quiet: no presence, no advisory
   * notices, blocking ones stay. Counts only while it names the Lane's current head. */
  superseded?: { laneHead: string };
  /** Cross-file symbol facts of `changes`, when the caller holds them without the full evidence. */
  symbolFacts?: ReturnType<typeof symbolFacts>;
};
export type OverlapMain = {
  sequence: number;
  coverageAfter: number;
  changes: string;
};
const same = (a: OverlapFile, b: OverlapFile) =>
  a === null || b === null ? a === b : a.blob === b.blob && a.mode === b.mode;

/** A display projection budget, never a source/save limit. Missing coverage is explicit. */
export function boundOverlapChanges(changes: OverlapChange[], complete = true) {
  const selected: OverlapChange[] = [];
  let bytes = 2,
    legacyBytes = 2;
  const evidence: { index: number; change: OverlapChange }[] = [];
  for (const change of changes) {
    const value: OverlapChange = {
      path: change.path,
      before: change.before && { blob: change.before.blob, mode: change.before.mode },
      after: change.after && { blob: change.after.blob, mode: change.after.mode },
    };
    // Preserve the old preflight-availability boundary while compacting advice. Cross-file
    // symbol facts have their own cap below and never change that boundary.
    legacyBytes +=
      new TextEncoder().encode(
        JSON.stringify({
          ...value,
          ...(change.evidence ? { evidence: { ...change.evidence, symbolLinks: undefined } } : {}),
        }),
      ).length + 1;
    const size = new TextEncoder().encode(JSON.stringify(value)).length + 1;
    if (bytes + size > OVERLAP_METADATA_BYTES) {
      complete = false;
      continue;
    }
    if (change.evidence) evidence.push({ index: selected.length, change });
    selected.push(value);
    bytes += size;
  }
  complete &&= legacyBytes <= OVERLAP_METADATA_BYTES;
  let linkBytes = 0;
  for (const { index, change } of evidence) {
    // Keep full metadata while it fits, including across successive saves.
    // Once legacy coverage is incomplete, spend bytes on ranges before unused
    // declaration names. The incomplete flag propagates through later saves.
    const { symbolLinks, ...plain } = change.evidence!;
    const ranges = complete ? plain : { ...plain, symbols: [] };
    const size = new TextEncoder().encode(JSON.stringify(ranges)).length + 12;
    if (bytes + size > OVERLAP_METADATA_BYTES) {
      // Preserve the previous unavailable-preflight behavior when evidence does
      // not fit. Retained paths improve advice without expanding enforcement.
      complete = false;
      continue;
    }
    selected[index]!.evidence = ranges;
    bytes += size;
    if (!symbolLinks) continue;
    // Facts past the cap read as unavailable, never as "no link".
    let links = symbolLinks,
      extra = new TextEncoder().encode(JSON.stringify(links)).length + 16;
    if (
      !('unavailable' in links) &&
      (linkBytes + extra > SYMBOL_LINK_BYTES || bytes + extra > OVERLAP_METADATA_BYTES)
    ) {
      links = { unavailable: true };
      extra = 40;
    }
    if (bytes + extra > OVERLAP_METADATA_BYTES) continue;
    selected[index]!.evidence = { ...ranges, symbolLinks: links };
    bytes += extra;
    linkBytes += extra;
  }
  return { changes: JSON.stringify(selected), complete };
}

/** Keep the first baseline bytes so edits reverted to the base stop overlapping. */
export function mergeOverlapChanges(previous: OverlapChange[], delta: OverlapChange[], complete = true) {
  const paths = new Map(previous.map(change => [change.path, change]));
  for (const change of delta) {
    const before = paths.get(change.path)?.before ?? change.before;
    // A missing baseline file is significant; do not replace null via ??.
    const original = paths.has(change.path) ? paths.get(change.path)!.before : before;
    if (same(original, change.after)) paths.delete(change.path);
    else paths.set(change.path, { ...change, before: original });
  }
  return boundOverlapChanges(
    [...paths.values()].sort((a, b) => a.path.localeCompare(b.path)),
    complete,
  );
}

/** Latest main touch per path replaces a walk through acceptance history. */
export function advanceOverlapMain(
  previous: OverlapMain | null,
  sequence: number,
  paths: string[] | null,
): OverlapMain {
  const changes = new Map<string, number>(previous ? JSON.parse(previous.changes) : []);
  let coverageAfter = previous?.coverageAfter ?? sequence - 1;
  if (paths === null) coverageAfter = sequence;
  for (const path of paths ?? []) changes.set(path, sequence);
  const ordered = [...changes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const selected: [string, number][] = [];
  let bytes = 2;
  for (const entry of ordered) {
    const size = new TextEncoder().encode(JSON.stringify(entry)).length + 1;
    if (bytes + size > OVERLAP_METADATA_BYTES) {
      coverageAfter = Math.max(coverageAfter, entry[1]);
      continue;
    }
    selected.push(entry);
    bytes += size;
  }
  return { sequence, coverageAfter, changes: JSON.stringify(selected) };
}

/** Saved range/path advice. Actual text conflicts are still decided by composition. */
export function hostedOverlapAdvice(
  mine: OverlapLane,
  peers: OverlapLane[],
  main: OverlapMain | null,
  current: { head: string; sourceRevision: number },
  answered: Set<string>,
  complete = true,
  maxItems = 5,
  requestedPath?: string,
  /** Collapse advisory notices of Lanes idle since before `idleBefore` (ms) into one summary item. */
  idleBefore?: number,
) {
  const mineChanges = new Map(
    (JSON.parse(mine.changes) as OverlapChange[]).map(change => [change.path, change]),
  );
  const paths = new Set(mineChanges.keys());
  const mineFacts = symbolFacts([...mineChanges.values()]);
  complete &&= mine.complete;
  const items: {
    noticeId: string;
    class: OverlapClass;
    reason: string;
    file: string;
    lanes: string[];
    text: string;
    participants: { lane: string; actor: string; intent: string }[];
  }[] = [];
  let count = 0,
    blockingCount = 0,
    advisoryCount = 0;
  const idleLanes = new Set<string>(),
    idleFiles = new Set<string>();
  for (const peer of peers) {
    if (!peer.open || peer.laneId === mine.laneId) continue;
    const quiet = peer.superseded?.laneHead === peer.head;
    const idle =
      idleBefore !== undefined &&
      !requestedPath &&
      (peer.lastActivityAt ?? peer.presenceRow?.at ?? Infinity) < idleBefore;
    if (
      mine.intentId === peer.intentId &&
      ((mine.resolutionLeft &&
        (mine.resolutionLeft === peer.head || mine.resolutionLeft === peer.resolutionLeft)) ||
        (peer.resolutionLeft && peer.resolutionLeft === mine.head))
    )
      continue;
    complete &&= peer.complete;
    const lanes = [mine.laneId, peer.laneId].sort();
    const peerChanges = JSON.parse(peer.changes) as OverlapChange[];
    let visible = false;
    for (const change of peerChanges) {
      const { path } = change,
        mineChange = mineChanges.get(path);
      if (requestedPath ? path !== requestedPath : !mineChange) continue;
      const classification = mineChange
        ? classifyOverlap(mineChange, change)
        : { class: 'advisory' as const, reason: 'requested-path' };
      // Known clean pairs are quiet. Missing evidence remains visible and incomplete,
      // so older clients, different bases and non-text files cannot create new misses.
      // Explicit peers(path) still shows saved activity before a first write.
      if (!requestedPath && classification.class === 'advisory' && quiet) continue;
      if (classification.reason === 'unavailable') complete = false;
      if (!requestedPath && classification.class === 'advisory' && classification.reason !== 'unavailable')
        continue;
      visible = true;
      if (classification.class === 'advisory' && idle) {
        idleLanes.add(peer.laneId);
        idleFiles.add(path);
        continue;
      }
      const priority = classification.class === 'blocking';
      // Without answers there is no need to hash every omitted display item.
      const noticeId =
        answered.size ||
        items.length < maxItems ||
        (priority && items.some(item => item.class === 'advisory'))
          ? digest(JSON.stringify([priority ? 'first-write' : 'first-write-advisory', lanes, path]))
          : '';
      if (answered.has(noticeId)) continue;
      count++;
      if (priority) blockingCount++;
      else advisoryCount++;
      if (items.length === maxItems && (!priority || items.every(item => item.class === 'blocking')))
        continue;
      const item = {
        noticeId,
        ...classification,
        file: path,
        lanes,
        participants: [mine, peer].map(lane => ({
          lane: lane.laneId,
          actor: agentActor(lane.actor, lane.agent),
          intent: lane.intent,
        })),
        text: `${classification.class} overlap: ${path}; Lane ${peer.laneId} (${peer.intent.slice(0, 160)}); ${classification.reason}.`.slice(
          0,
          400,
        ),
      };
      if (priority) items.splice(items.findIndex(item => item.class === 'advisory') >>> 0, 0, item);
      else items.push(item);
      if (items.length > maxItems) items.pop();
    }
    // One advisory cross-file note per Lane pair, only when no same-file notice already names the pair.
    const note =
      requestedPath || visible || quiet
        ? null
        : crossFileSymbolNote(mineFacts, peer.symbolFacts ?? symbolFacts(peerChanges));
    const noteId = note && digest(JSON.stringify(['cross-file-symbol', lanes]));
    if (note && idle) {
      idleLanes.add(peer.laneId);
      idleFiles.add(note.file);
    } else if (note && noteId && !answered.has(noteId)) {
      count++;
      advisoryCount++;
      if (items.length < maxItems)
        items.push({
          noticeId: noteId,
          class: 'advisory',
          reason: 'cross-file-symbol',
          file: note.file,
          lanes,
          participants: [mine, peer].map(lane => ({
            lane: lane.laneId,
            actor: agentActor(lane.actor, lane.agent),
            intent: lane.intent,
          })),
          text: symbolNoteText(note, peer.laneId, peer.intent),
        });
    }
  }
  if (idleLanes.size) {
    // One advisory line for every idle Lane, in place of one notice per file and Lane.
    const ids = [...idleLanes].sort(),
      files = [...idleFiles].sort();
    const noticeId = digest(JSON.stringify(['idle-lanes', mine.laneId, ids]));
    if (!answered.has(noticeId)) {
      count++;
      advisoryCount++;
      const hours = IDLE_NOTICE_MS / 3_600_000;
      const item = {
        noticeId,
        class: 'advisory' as const,
        reason: 'idle-lanes',
        file: files[0]!,
        lanes: ids.slice(0, 3),
        participants: [],
        text: `advisory: ${ids.length} Lane(s) idle over ${hours} h also touch ${files.length} of your files (${files[0]}${files.length > 1 ? ', ...' : ''}); their work may already be on main. No answer needed.`,
      };
      // A full list gives up its last advisory item; blocking ones are never displaced.
      if (items.length >= maxItems) {
        const last = items.map(entry => entry.class).lastIndexOf('advisory');
        if (last >= 0) items.splice(last, 1);
      }
      if (items.length < maxItems) items.push(item);
    }
  }
  const knownBase = mine.baseSequence !== null;
  const behind = knownBase ? Math.max(0, current.sourceRevision - mine.baseSequence!) : null;
  const mainComplete =
    current.head === mine.baseHead ||
    (knownBase &&
      main !== null &&
      main.sequence === current.sourceRevision &&
      mine.baseSequence! >= main.coverageAfter);
  const conflicts =
    main && knownBase && current.head !== mine.baseHead
      ? (JSON.parse(main.changes) as [string, number][])
          .filter(([path, sequence]) => sequence > mine.baseSequence! && paths.has(path))
          .map(([path]) => path)
          .sort()
      : [];
  return {
    unacknowledgedOverlaps: {
      laneId: mine.laneId,
      head: mine.head,
      count,
      blockingCount,
      advisoryCount,
      items,
      coverage: complete ? 'hosted' : 'hosted-incomplete',
    },
    behindMain: {
      head: current.head,
      baseHead: mine.baseHead,
      baseSequence: mine.baseSequence,
      commits: behind,
      conflictingPaths: conflicts.slice(0, 10),
      more: Math.max(0, conflicts.length - 10),
      coverage: mainComplete && mine.complete ? 'hosted' : 'hosted-incomplete',
    },
  };
}
