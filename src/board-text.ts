// SPDX-License-Identifier: Apache-2.0
// Board message text: validation at post (server and client) and notice rendering (client).
// No Node globals: the Convex V8 runtime imports this module.
import { BOUNDARY_CREDENTIAL_PREFIXES, CREDENTIAL_PREFIXES } from './credential-prefixes.js';
import { safeRelative } from './safe-relative.js';
import { invariant } from './errors.js';

/** Owner limit (2026-11-05): short text only, one line. */
export const BOARD_TEXT_CHARS = 240;
export const BOARD_NOTICE_CHARS = 240;
export const BOARD_PATHS = 10;
export const BOARD_PATH_CHARS = 200;

const boundary = `(?:^|[\\s"'(=:\\[{,])`;
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The redactor's prefixes, each followed by a credential-shaped value. "Basic idea" is text;
 * "Basic dXNlcjpwYXNzd29yZA==" is not. Plus well-known key shapes. */
const secretShapes = [
  ...CREDENTIAL_PREFIXES.map(prefix => {
    const value = prefix.endsWith('=') ? '[^\\s"\']{8,}' : '[A-Za-z0-9+/=._~-]{16,}';
    const start = BOUNDARY_CREDENTIAL_PREFIXES.includes(prefix) ? boundary : '';
    return new RegExp(`${start}${escape(prefix)}${value}`);
  }),
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /xox[abprs]-[A-Za-z0-9-]{10,}/,
  /AIza[0-9A-Za-z_-]{35}/,
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/,
];
const emailShape = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
/** Absolute, home and drive paths name a machine; repository paths are relative. */
const machinePath = new RegExp(`${boundary}(?:/[A-Za-z0-9._-]|~/|[A-Za-z]:\\\\|file://)`);
/** Control, line and bidirectional-override characters: one visible line only. */
const controls = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

/** Reject, never redact: the error names what to remove. */
export function boardTextProblem(text: string): { code: string; message: string } | null {
  const chars = [...text].length;
  if (!text.trim()) return { code: 'BOARD_TEXT_EMPTY', message: 'Write a short note (1-240 characters).' };
  if (chars > BOARD_TEXT_CHARS)
    return {
      code: 'BOARD_TEXT_TOO_LONG',
      message: `Notes are at most ${BOARD_TEXT_CHARS} characters (got ${chars}). Shorten it.`,
    };
  if (controls.test(text))
    return {
      code: 'BOARD_TEXT_CONTROL',
      message: 'Remove line breaks and control characters: notes are one line.',
    };
  if (secretShapes.some(shape => shape.test(text)))
    return {
      code: 'BOARD_TEXT_SECRET',
      message: 'This note looks like it contains a credential or key. Remove it; never post secrets.',
    };
  if (emailShape.test(text))
    return {
      code: 'BOARD_TEXT_EMAIL',
      message: 'Remove the email address: the board shows Forge handles only.',
    };
  if (machinePath.test(text))
    return {
      code: 'BOARD_TEXT_PATH',
      message: 'Remove absolute or home paths; name repository files by relative path (src/x.ts).',
    };
  return null;
}

export function assertBoardText(text: string) {
  const problem = boardTextProblem(text);
  invariant(!problem, problem?.code ?? 'BAD_ARGUMENT', problem?.message ?? '');
}

export function assertBoardPaths(paths: readonly string[] | undefined) {
  if (!paths) return;
  invariant(paths.length <= BOARD_PATHS, 'BAD_ARGUMENT', `At most ${BOARD_PATHS} paths per note.`);
  for (const path of paths)
    invariant(
      path.length <= BOARD_PATH_CHARS && safeRelative(path) && !controls.test(path),
      'BAD_ARGUMENT',
      `paths are repository-relative files (at most ${BOARD_PATH_CHARS} characters each).`,
    );
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A full UUID or a unique prefix of at least 8 hex characters (dashes kept). */
const prefix = /^[0-9a-f]{8}[0-9a-f-]{0,28}$/;
export type BoardTarget = { kind: 'project' } | { kind: 'lane'; ref: string } | { kind: 'issue'; id: string };
export function parseBoardTarget(to: string): BoardTarget {
  if (to === 'project') return { kind: 'project' };
  const [kind, ref = ''] = to.split(/:(.*)/s, 2);
  const id = ref.toLowerCase();
  if (kind === 'lane' && prefix.test(id)) return { kind: 'lane', ref: id };
  if (kind === 'issue' && uuid.test(id)) return { kind: 'issue', id };
  invariant(
    false,
    'BAD_ARGUMENT',
    'to is "lane:LANE_ID" (full id or 8+ character prefix), "issue:ISSUE_ID" (full id) or "project".',
  );
}
export function boardIdPrefix(id: string) {
  const value = id.toLowerCase();
  invariant(prefix.test(value), 'BAD_ARGUMENT', 'Message ids are UUIDs or 8+ character prefixes.');
  return value;
}

export type BoardMessageView = {
  id: string;
  /** A Forge handle after the public identity mapping; absent when the viewer may not see it. */
  author?: string;
  fromLaneId?: string;
  to: string;
  text: string;
  paths?: string[];
  replyTo?: string;
  at: number;
};
const short = (id: string) => id.slice(0, 8);
const target = (to: string, laneId?: string) =>
  to === 'project'
    ? 'the project'
    : to === `lane:${laneId}`
      ? 'your Lane'
      : to.startsWith('lane:')
        ? `Lane ${short(to.slice(5))}`
        : `Issue ${short(to.slice(6))}`;

/** One line, at most 240 characters. Peer text is quoted as data, never as an instruction. */
export function renderBoardNotice(message: BoardMessageView, laneId?: string): string {
  const id = short(message.id);
  const who = message.author ? `@${message.author}` : 'a member';
  const from = message.fromLaneId ? ` (Lane ${short(message.fromLaneId)})` : '';
  const kind = message.replyTo ? `Reply ${id} to ${short(message.replyTo)}` : `Note ${id}`;
  const head = `${kind} from ${who}${from} to ${target(message.to, laneId)}, quoted data: "`;
  const more = `… (board {"id":"${id}"})`;
  const tail = `". Reply: board --reply {"id":"${id}"}`;
  const body = message.text.replace(new RegExp(controls.source, 'g'), ' ');
  const room = BOARD_NOTICE_CHARS - head.length - tail.length;
  const chars = [...body];
  const quoted =
    chars.length <= room ? body : chars.slice(0, Math.max(0, room - more.length)).join('') + more;
  return (head + quoted + tail).slice(0, BOARD_NOTICE_CHARS);
}
