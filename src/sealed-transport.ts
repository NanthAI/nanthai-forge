// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import { coordinationClient } from './coordination-client.js';
import { ForgeError, invariant } from './errors.js';
import { framedHash } from './sealed-format.js';
import { headBytes } from './sealed-records.js';
import { decodeSealedReply } from './sealed-decode.js';
import type { SealedReply } from './sealed-verify.js';
import { encodeSealedWire, decodeSealedWire } from './sealed-wire.js';

const encode = (value: unknown) => encodeSealedWire(value).buffer as ArrayBuffer;
const decode = (bytes: ArrayBuffer) =>
  decodeSealedWire(new Uint8Array(bytes), view => Buffer.from(view.buffer, view.byteOffset, view.byteLength));

const binary = (bytes: Uint8Array) => Uint8Array.from(bytes).buffer;
export type SealedHistoryWire = {
  genesis: ArrayBuffer;
  transitions: ArrayBuffer[];
};
/** The local journal record of one head write. `history` stays local for re-verification; the
 * server takes only `sealedWriteArgs`. */
export type SealedWrite = {
  operationId: string;
  prevHeadHash: ArrayBuffer | null;
  setId: ArrayBuffer;
  headHash: ArrayBuffer;
  headVersion: number;
  rosterVersion: number;
  payload: ArrayBuffer;
  history: SealedHistoryWire | null;
  /** The roster transition this write introduces, if any. Older journal records lack it. */
  transition?: ArrayBuffer | null;
};
/** The mutation arguments: everything else is derived from the payload by the server. */
export type SealedWriteArgs = {
  operationId: string;
  payload: ArrayBuffer;
  genesis: ArrayBuffer | null;
  transition: ArrayBuffer | null;
};
export type SealedReadWire = {
  payload: ArrayBuffer | null;
  history: SealedHistoryWire | null;
  /** Server-owned removal markers; absent when there are none. */
  revoked?: ArrayBuffer[];
  /** Server-owned join requests; absent when there are none. */
  joinRequests?: ArrayBuffer[];
  /** Gate B2 M3: this sign-in has no sealed device link in the project yet; absent from older deployments. */
  unlinked?: true;
};
export interface SealedTransport {
  read(input: {
    kind: 1 | 2 | 3;
    headHash?: ArrayBuffer;
    rosterVersion?: number;
  }): Promise<SealedReadWire | null>;
  write(input: SealedWriteArgs & { kind: 1 | 2 | 3 }): Promise<{ accepted: boolean; replay: boolean }>;
  /** Design 5.1: post this device's own join request (sealedSecrets:join). */
  join?(input: { kind: 1 | 2 | 3; request: ArrayBuffer }): Promise<{ accepted: boolean; replay: boolean }>;
  /** Gate B2 M3: record this device on its sign-in, so ending the sign-in elsewhere marks it (sealedSecrets:link). */
  link?(input: { kind: 1 | 2 | 3; deviceId: ArrayBuffer }): Promise<{ linked: boolean }>;
}
const refusals = new Set([
  'AUTH_REQUIRED',
  'AUTH_EXPIRED',
  'AUTH_REVOKED',
  'AUTH_SCOPE_DENIED',
  'PROJECT_UNAVAILABLE',
  'SECRETS_FORMAT_REFUSED',
  'SECRETS_SET_REPLACED',
  'SECRETS_NOT_ALLOWED',
  'SECRETS_NOT_SET_UP',
  'WORK_OPERATION_REUSED',
  'HOSTED_SCHEMA_REJECTED',
  'BAD_ARGUMENT',
]);
/** A storage reply that proves the mutation stored nothing, as a terminal error; null when the outcome is unknown.
 * Convex checks arguments before a mutation runs, so an argument-validation failure (a CLI build whose request
 * shape the deployment does not take) is a refusal, never an unknown outcome to retry for ever. */
export function sealedRefusal(error: unknown): ForgeError | null {
  const code =
    error instanceof ForgeError ? error.code : (error as { data?: { code?: unknown } })?.data?.code;
  if (typeof code === 'string' && refusals.has(code)) {
    // The server's own reason for a sealed refusal is shown as untrusted text: printable, one line, bounded.
    const raw =
      error instanceof ForgeError
        ? error.message
        : (error as { data?: { message?: unknown } })?.data?.message;
    const reason =
      code.startsWith('SECRETS_') && typeof raw === 'string'
        ? raw
            .replace(/[^\x20-\x7e]/g, ' ')
            .trim()
            .slice(0, 240)
        : '';
    return new ForgeError(
      code,
      `Secret storage refused this operation${reason ? `: ${reason}` : ''}; local trust was not changed.`,
    );
  }
  if (error instanceof Error && /ArgumentValidationError|Value does not match validator/.test(error.message))
    return new ForgeError(
      'CLI_UPDATE_REQUIRED',
      "Secret storage does not take this CLI build's request, so nothing was stored. Update the CLI (nforge update), then repeat the change as a new operation.",
    );
  return null;
}
/** Transport serialization is never signed or hashed. All authentication uses format frames.
 * `previous` is the verified head this write replaces. Markers and proposals are server-owned, so the
 * payload never carries them; the write introduces at most the one transition past `previous`. */
export function sealedWrite(
  reply: SealedReply,
  operationId: string,
  previous: { headHash: Buffer; rosterVersion: number } | null,
): SealedWrite {
  const { genesis, transitions, ...current } = reply;
  const introduced = previous ? transitions.filter(t => t.fromVersion >= previous.rosterVersion) : [];
  invariant(introduced.length <= 1, 'SECRETS_FORMAT_REFUSED', 'A write introduces at most one roster step.');
  return {
    operationId,
    prevHeadHash: previous ? binary(previous.headHash) : null,
    setId: binary(reply.roster.setId),
    headHash: binary(framedHash(headBytes(reply.head))),
    headVersion: reply.head.headVersion,
    rosterVersion: reply.roster.rosterVersion,
    payload: encode({ ...current, revoked: [], proposals: [] }),
    history: {
      genesis: encode(genesis),
      transitions: transitions.slice(-64).map(encode),
    },
    transition: introduced[0] ? encode(introduced[0]) : null,
  };
}
export const sealedWriteArgs = (wire: SealedWrite): SealedWriteArgs => ({
  operationId: wire.operationId,
  payload: wire.payload,
  genesis: wire.prevHeadHash === null && wire.history ? wire.history.genesis : null,
  transition: wire.transition ?? null,
});
export function sealedRead(wire: SealedReadWire, cached?: SealedReply): SealedReply {
  const revoked = (wire.revoked ?? []).map(id => Buffer.from(id));
  if (!wire.payload) {
    invariant(cached, 'SECRETS_PIN_LOST', 'The local ciphertext cache is missing.');
    return decodeSealedReply({ ...cached, revoked });
  }
  invariant(
    wire.payload.byteLength <= 512 * 1024,
    'SECRETS_FORMAT_REFUSED',
    'Sealed record exceeds format bounds.',
  );
  const current = decode(wire.payload) as Omit<SealedReply, 'genesis' | 'transitions'>;
  const genesis = wire.history ? (decode(wire.history.genesis) as SealedReply['genesis']) : cached?.genesis;
  invariant(genesis, 'SECRETS_PIN_TOO_OLD', 'Secret genesis history is missing.');
  return decodeSealedReply({
    ...current,
    revoked,
    genesis,
    transitions: wire.history
      ? wire.history.transitions.map(t => decode(t) as SealedReply['transitions'][number])
      : (cached?.transitions ?? []),
  });
}
export function hostedSealedTransport(deployment: string, projectId: string, token: string): SealedTransport {
  const client = coordinationClient(deployment, token);
  return {
    read: input =>
      client.query(makeFunctionReference<'query'>('sealedSecrets:read'), { projectId, ...input }),
    write: input =>
      client.mutation(makeFunctionReference<'mutation'>('sealedSecrets:write'), { projectId, ...input }),
    join: input =>
      client.mutation(makeFunctionReference<'mutation'>('sealedSecrets:join'), { projectId, ...input }),
    link: input =>
      client.mutation(makeFunctionReference<'mutation'>('sealedSecrets:link'), { projectId, ...input }),
  };
}
