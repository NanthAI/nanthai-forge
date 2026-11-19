// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { invariant } from './errors.js';

/** Keeps eight worst-case escaped messages within the existing 512 KiB publication budget: an
 * eight-member batch step writes about 264 bytes per message byte (478 KB at this limit). */
export const LANDING_MESSAGE_BYTES = 1024;
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

/** Supplied messages stay ordered; only Forge creates its identity trailers. */
export function mirrorMessage(input: {
  message?: string | undefined;
  cohortMessages?: string[] | undefined;
  fallback: string;
  state: string;
  acceptanceId: string;
  viewId: string;
  trailers?: string[] | undefined;
}) {
  const messages = input.cohortMessages ?? (input.message === undefined ? [] : [input.message]);
  const prose = messages.length ? messages.map(landingMessage).join('\n\n') : cleanMessage(input.fallback);
  return [
    prose.replace(/\n+$/, ''),
    '',
    ...(input.trailers ?? []),
    `Forge-State: ${input.state}`,
    `Forge-Acceptance: ${input.acceptanceId}`,
    `Forge-View: ${input.viewId}`,
  ].join('\n');
}

/** A note after the subject paragraph of a mirror message, ahead of the Forge trailers. */
export function noteMessage(message: string, note: string) {
  const split = message.indexOf('\n\n');
  return split < 0 ? `${message}\n\n${note}` : `${message.slice(0, split)}\n\n${note}${message.slice(split)}`;
}

const trailerLine = /^[A-Za-z][A-Za-z0-9-]*: \S/;
/** Trailers (last paragraph of `Key: value` lines) of a finish message that a mirror commit message lacks. */
export function lostTrailers(finishMessage: string, commitMessage: string) {
  const paragraphs = cleanMessage(finishMessage)
    .trim()
    .split(/\n{2,}/);
  const last = paragraphs.length > 1 ? paragraphs.at(-1)!.split('\n') : [];
  const kept = new Set(commitMessage.split('\n'));
  return last.every(line => trailerLine.test(line)) ? last.filter(line => !kept.has(line)) : [];
}
