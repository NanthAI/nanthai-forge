// SPDX-License-Identifier: Apache-2.0
// Board state kept on this machine. Light on purpose: the first-write hook loads it on every first
// write (CPU budget), so it imports Node builtins, root paths and the pure notice renderer only:
// no schema library, no Convex client.
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { clientCacheRoot, retainedRootSibling } from './root-paths.js';
import { renderBoardNotice } from './board-text.js';

const writeJson = (file: string, value: unknown) => {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, file);
};
const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
};

/** Read state stays on this machine: `ROOT.forge-client/board/<laneId>.json` holds the time of the
 * last delivered note. Delivery never writes to Forge; two machines on one Lane may each see a note.
 * It belongs to the Lane, not to the path an action ran from: `start` runs at the project root and
 * later actions inside the Lane checkout (`ROOT.forge-client/lanes/<id>`), and each kept its own
 * cursor, so a project-wide note showed again once per path (friction 9d7bd94f). The outermost
 * root's cache holds it for every path; the nested cache is read only so an old cursor still counts. */
const boardDir = (root: string) => join(retainedRootSibling(root, '.forge-client'), 'board');
const cursorFile = (root: string, laneId: string) => join(boardDir(root), `${laneId}.json`);
const nestedCursorFile = (root: string, laneId: string) =>
  join(clientCacheRoot(root), 'board', `${laneId}.json`);
const cursorAt = (file: string) => {
  const value = readJson(file) as { after?: unknown } | undefined;
  return typeof value?.after === 'number' && Number.isFinite(value.after) ? value.after : 0;
};
/** Account/project scope learned from the capability read already made by Lane actions. The hook
 * reuses this local marker. Hash it so the cursor contains no account identity. */
export function rememberBoardReader(root: string, projectId: string, actor: string) {
  const reader = createHash('sha256')
    .update(JSON.stringify([projectId, actor]))
    .digest('hex');
  const file = join(boardDir(root), 'reader.json');
  if ((readJson(file) as { reader?: unknown } | undefined)?.reader !== reader) writeJson(file, { reader });
}
const projectCursorFile = (root: string) => {
  const reader = (readJson(join(boardDir(root), 'reader.json')) as { reader?: unknown } | undefined)?.reader;
  return typeof reader === 'string' && /^[a-f0-9]{64}$/.test(reader)
    ? join(boardDir(root), `project-${reader}.json`)
    : undefined;
};
export function readBoardProjectCursor(root: string): number {
  const file = projectCursorFile(root);
  return file ? cursorAt(file) : 0;
}
export function writeBoardProjectCursor(root: string, after: number) {
  const file = projectCursorFile(root);
  if (file && after > cursorAt(file)) writeJson(file, { after });
}
/** Lane/Issue notes retain the Lane cursor; project notes already read by this actor in another
 * Lane do not repeat. Filter only bytes already returned by the existing query. */
export function unreadBoardNotes(root: string, messages: BoardNote[]): BoardNote[] {
  const after = readBoardProjectCursor(root);
  return messages.filter(message => message.target !== 'project' || message.at > after);
}
export function readBoardCursor(root: string, laneId: string): number {
  const shared = cursorFile(root, laneId);
  const nested = nestedCursorFile(root, laneId);
  return Math.max(cursorAt(shared), nested === shared ? 0 : cursorAt(nested));
}
export function writeBoardCursor(root: string, laneId: string, after: number) {
  if (after <= readBoardCursor(root, laneId)) return;
  writeJson(cursorFile(root, laneId), { after });
}

/** A delivered note as the server returns it (author already a Forge handle, or absent). */
export type BoardNote = {
  id: string;
  author?: string | undefined;
  fromLaneId?: string | undefined;
  target: string;
  text: string;
  replyTo?: string | undefined;
  at: number;
  /** Set only on a withdrawn note an explicit read returned. */
  resolved?: { by?: string | undefined; at: number; text?: string | undefined } | undefined;
};
export type BoardDeliveryValue = { messages: BoardNote[]; more: number; cursor: number };
export const boardNoticeLine = (message: BoardNote, laneId?: string) =>
  renderBoardNotice(
    {
      id: message.id,
      ...(message.author ? { author: message.author } : {}),
      ...(message.fromLaneId ? { fromLaneId: message.fromLaneId } : {}),
      to: message.target,
      text: message.text,
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      at: message.at,
      ...(message.resolved ? { resolved: message.resolved } : {}),
    },
    laneId,
  );

/** Envelope field for delivered notes: one line per note (≤240 chars each, ≤2 per reply). Writes
 * the local cursor, so the same notes are not shown again on this machine. */
export function boardEnvelope(root: string, laneId: string, delivered: BoardDeliveryValue) {
  const messages = unreadBoardNotes(root, delivered.messages);
  writeBoardCursor(root, laneId, delivered.cursor);
  for (const message of messages) if (message.target === 'project') writeBoardProjectCursor(root, message.at);
  const notices = messages.map(message => boardNoticeLine(message, laneId));
  return {
    notices: delivered.more ? [...notices, `${delivered.more}+ more: board '{}'`] : notices,
    more: delivered.more,
  };
}

/** Board features the server last advertised for a project, kept on this machine so the
 * first-write hook (which makes one query and no capability read) knows whether it may send its
 * board argument. Written only when the set changes; absent means "send nothing new". Test
 * processes never touch the developer's real state unless they select one. */
const noState = () => Boolean(process.env.NODE_TEST_CONTEXT) && !process.env.XDG_STATE_HOME;
const serverFile = (projectId: string) =>
  join(
    process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'),
    'forge',
    'board',
    `server-${projectId.replace(/[^A-Za-z0-9_-]/g, '')}.json`,
  );
const boardFeatureNames = ['agent-board', 'board-wait', 'board-claims', 'agent-slug', 'board-resolve'];
export function readBoardServerFeatures(projectId: string): string[] {
  if (noState()) return [];
  const value = readJson(serverFile(projectId)) as { features?: unknown } | undefined;
  return Array.isArray(value?.features)
    ? value.features.filter((item): item is string => typeof item === 'string')
    : [];
}
export function rememberBoardServerFeatures(projectId: string, advertised: readonly string[]) {
  if (noState()) return;
  const features = boardFeatureNames.filter(name => advertised.includes(name));
  if (JSON.stringify(features) === JSON.stringify(readBoardServerFeatures(projectId))) return;
  try {
    writeJson(serverFile(projectId), { features });
  } catch {
    /* Advisory only: the hook then sends no board argument. */
  }
}

/** Per-Lane early-return time, beside the board cursor (ROOT.forge-client/board/). */
const wakeFile = (root: string, laneId: string) => join(boardDir(root), `${laneId}.wake.json`);
export function readBoardWokeAt(root: string, laneId: string): number {
  const value = readJson(wakeFile(root, laneId)) as { at?: unknown } | undefined;
  return typeof value?.at === 'number' && Number.isFinite(value.at) ? value.at : 0;
}
export function writeBoardWokeAt(root: string, laneId: string, at = Date.now()) {
  try {
    writeJson(wakeFile(root, laneId), { at });
  } catch {
    /* The window is advisory. */
  }
}
