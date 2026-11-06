// SPDX-License-Identifier: Apache-2.0
// Board state kept on this machine. Light on purpose: the first-write hook loads it on every first
// write (CPU budget), so it imports Node builtins, root paths and the pure notice renderer only:
// no schema library, no Convex client.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { clientCacheRoot } from './root-paths.js';
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
 * last delivered note. Delivery never writes to Forge; two machines on one Lane may each see a note. */
const cursorFile = (root: string, laneId: string) => join(clientCacheRoot(root), 'board', `${laneId}.json`);
export function readBoardCursor(root: string, laneId: string): number {
  const value = readJson(cursorFile(root, laneId)) as { after?: unknown } | undefined;
  return typeof value?.after === 'number' && Number.isFinite(value.after) ? value.after : 0;
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
    },
    laneId,
  );

/** Envelope field for delivered notes: one line per note (≤240 chars each, ≤2 per reply). Writes
 * the local cursor, so the same notes are not shown again on this machine. */
export function boardEnvelope(root: string, laneId: string, delivered: BoardDeliveryValue) {
  writeBoardCursor(root, laneId, delivered.cursor);
  const notices = delivered.messages.map(message => boardNoticeLine(message, laneId));
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
const boardFeatureNames = ['agent-board', 'board-wait', 'board-claims', 'agent-slug'];
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
const wakeFile = (root: string, laneId: string) =>
  join(clientCacheRoot(root), 'board', `${laneId}.wake.json`);
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
