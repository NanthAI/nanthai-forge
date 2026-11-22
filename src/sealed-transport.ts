// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import { coordinationClient } from './coordination-client.js';
import { invariant } from './errors.js';
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
  rotateLists: ArrayBuffer[];
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
};
export interface SealedTransport {
  read(input: {
    kind: 1 | 2 | 3;
    headHash?: ArrayBuffer;
    rosterVersion?: number;
  }): Promise<SealedReadWire | null>;
  write(input: SealedWriteArgs & { kind: 1 | 2 | 3 }): Promise<{ accepted: boolean; replay: boolean }>;
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
      rotateLists: [],
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
  };
}
