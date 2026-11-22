// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { invariant } from './errors.js';
import { AGENT_CLIENT } from './agent-slug.js';

/** A git-like 16 KiB. Each message is stored once and referenced (Item 8c50ce13), so an eight-member
 * batch step writes the same bytes whatever its messages hold and stays inside the 512 KiB budget. */
export const LANDING_MESSAGE_BYTES = 16 * 1024;
export function landingMessage(value: string) {
  const size = new TextEncoder().encode(value).length;
  invariant(
    size <= LANDING_MESSAGE_BYTES,
    'LANDING_MESSAGE_TOO_LARGE',
    `This landing message (the commit message) has ${size} UTF-8 bytes; the limit is ${LANDING_MESSAGE_BYTES}. Shorten it and run the same command again.`,
  );
  const clean = cleanMessage(value);
  invariant(
    new TextEncoder().encode(clean).length <= LANDING_MESSAGE_BYTES,
    'LANDING_MESSAGE_TOO_LARGE',
    `The escaped landing message must fit in ${LANDING_MESSAGE_BYTES} UTF-8 bytes.`,
  );
  return clean;
}
/** The cap on a save or compose note: the note travels in finish rows and operations, so a long
 * landing message (stored once, by reference) is never copied into it (Item 8c50ce13). */
export const LANDING_NOTE_BYTES = 1024;
const utf8 = new TextEncoder();
/** A save or compose note as supplied: over the cap it fails with the limit and the byte count. */
export function noteText(value: string) {
  const size = utf8.encode(value).length;
  invariant(
    size <= LANDING_NOTE_BYTES,
    'LANDING_MESSAGE_TOO_LARGE',
    `This save or compose note has ${size} UTF-8 bytes; the limit is ${LANDING_NOTE_BYTES}. Shorten it and run the same command again.`,
  );
  return value;
}
/** The note a landing writes for its save and compose steps: the message itself, or its subject
 * (first line, whole characters) when the message is longer than the cap. */
export function landingNote(message: string) {
  if (utf8.encode(message).length <= LANDING_NOTE_BYTES) return message;
  let note = '';
  const subject = message.split(/\r?\n/).find(line => line.trim() !== '') ?? 'Agent change';
  for (const char of subject) {
    if (utf8.encode(note + char).length > LANDING_NOTE_BYTES) break;
    note += char;
  }
  return note;
}
export const noteSchema = z.string().transform(noteText);
/** A message the client supplies (land, finish, --message-file): empty text never reaches the server (friction 737e85cb). */
export function suppliedLandingMessage(value: string) {
  invariant(
    value.trim() !== '',
    'BAD_ARGUMENT',
    'The landing message (the commit message) is empty; write the message and run the command again. A withdrawn landing replays its original message, so pass a fresh operationId to change it.',
  );
  return landingMessage(value);
}
function cleanMessage(value: string) {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '')
    .replace(/^( *Forge-(?:State|Acceptance|View) *:)/gim, '> $1');
}
export const landingMessageSchema = z.string().transform(landingMessage);
export const cohortMessagesSchema = z.array(landingMessageSchema).max(8);

const trailerLine = /^[A-Za-z][A-Za-z0-9-]*: \S/;

/** The noreply address a co-author trailer uses for an agent, from its declared client or tool
 * name: the vendor's public noreply address, or Forge's neutral one. Never a person's address. */
export function agentNoreplyEmail(declared: string) {
  const text = declared.toLowerCase();
  return /claude|anthropic/.test(text)
    ? 'noreply@anthropic.com'
    : /codex|openai|gpt/.test(text)
      ? 'noreply@openai.com'
      : 'forge@localhost';
}

/** `Co-Authored-By` for a receipt's declared `agentClient` (`app` or `app:model`), in public words
 * only: the model and app as declared. Malformed or absent declarations credit nothing. */
function agentCredit(client: string | undefined) {
  if (!client || !AGENT_CLIENT.test(client)) return undefined;
  const [app, model] = client.split(':', 2);
  return `Co-Authored-By: ${model ? `${model} (${app})` : app} <${agentNoreplyEmail(client)}>`;
}

/** Git's trailer rule: the last paragraph, never the subject, whose lines are all `Key: value`
 * trailers or indented continuations of one. Returns the prose before it and each trailer. */
function splitTrailers(message: string) {
  const text = message.replace(/\n+$/, '');
  const at = text.lastIndexOf('\n\n');
  const lines = at < 0 ? [] : text.slice(at + 2).split('\n');
  if (
    !lines.length ||
    !trailerLine.test(lines[0]!) ||
    !lines.every(l => trailerLine.test(l) || /^[ \t]+\S/.test(l))
  )
    return { prose: text, trailers: [] as string[] };
  const trailers: string[] = [];
  for (const line of lines)
    if (trailerLine.test(line)) trailers.push(line);
    else trailers[trailers.length - 1] += `\n${line}`;
  return { prose: text.slice(0, at).replace(/\n+$/, ''), trailers };
}

/** One landing a mirror commit covers: its own message and declared agent client, and its receipt
 * when the commit is its own (a batch member; a catch-up lists receipts in its prose instead). */
export type MirrorMember = {
  message?: string | undefined;
  agentClient?: string | undefined;
  acceptanceId?: string | undefined;
};

/** Supplied messages stay ordered. Every message's trailers move into one final block, then each
 * covered landing's own co-authors, or a credit for its declared agent when it names none, then
 * Forge's trailers, with one `Forge-Acceptance` per member receipt in acceptance order (a single
 * landing has one); an exactly repeated trailer appears once. Only Forge creates its identity trailers. */
export function mirrorMessage(input: {
  message?: string | undefined;
  cohortMessages?: string[] | undefined;
  fallback: string;
  state: string;
  acceptanceId: string;
  viewId: string;
  trailers?: string[] | undefined;
  agentClient?: string | undefined;
  /** The landings this commit covers (batch members or a catch-up's landings); default: this one. */
  members?: MirrorMember[] | undefined;
}) {
  const messages = input.cohortMessages ?? (input.message === undefined ? [] : [input.message]);
  const parts = (messages.length ? messages.map(landingMessage) : [cleanMessage(input.fallback)]).map(
    splitTrailers,
  );
  const credits = (input.members ?? [{ message: input.message, agentClient: input.agentClient }]).flatMap(
    member => {
      // A landing's own co-authors stand for it, also where its prose is not in the commit (catch-up).
      const own = (
        member.message === undefined ? [] : splitTrailers(cleanMessage(member.message)).trailers
      ).filter(line => /^co-authored-by:/i.test(line));
      const credit = own.length ? [] : [agentCredit(member.agentClient)];
      return [...own, ...credit].filter((line): line is string => !!line);
    },
  );
  const seen = new Set<string>();
  const block = [...parts.flatMap(part => part.trailers), ...credits, ...(input.trailers ?? [])].filter(
    line => !seen.has(line) && !!seen.add(line),
  );
  // Every batch member's receipt, then this one (its last member), each once.
  const receipts = new Set([
    ...(input.members ?? []).flatMap(member => (member.acceptanceId ? [member.acceptanceId] : [])),
    input.acceptanceId,
  ]);
  return [
    parts.map(part => part.prose).join('\n\n'),
    '',
    ...block,
    `Forge-State: ${input.state}`,
    ...[...receipts].map(id => `Forge-Acceptance: ${id}`),
    `Forge-View: ${input.viewId}`,
  ].join('\n');
}

/** A note after the subject paragraph of a mirror message, ahead of the Forge trailers. */
export function noteMessage(message: string, note: string) {
  const split = message.indexOf('\n\n');
  return split < 0 ? `${message}\n\n${note}` : `${message.slice(0, split)}\n\n${note}${message.slice(split)}`;
}

/** Trailers (last paragraph of `Key: value` lines) of a finish message that a mirror commit message lacks. */
export function lostTrailers(finishMessage: string, commitMessage: string) {
  const paragraphs = cleanMessage(finishMessage)
    .trim()
    .split(/\n{2,}/);
  const last = paragraphs.length > 1 ? paragraphs.at(-1)!.split('\n') : [];
  const kept = new Set(commitMessage.split('\n'));
  return last.every(line => trailerLine.test(line)) ? last.filter(line => !kept.has(line)) : [];
}
