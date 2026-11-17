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
export type SealedWrite = {
  operationId: string;
  prevHeadHash: ArrayBuffer | null;
  setId: ArrayBuffer;
  headHash: ArrayBuffer;
  headVersion: number;
  rosterVersion: number;
  payload: ArrayBuffer;
  history: SealedHistoryWire | null;
};
export interface SealedTransport {
  read(input: {
    kind: 1 | 2 | 3;
    headHash?: ArrayBuffer;
    rosterVersion?: number;
  }): Promise<{ payload: ArrayBuffer | null; history: SealedHistoryWire | null } | null>;
  write(input: SealedWrite & { kind: 1 | 2 | 3 }): Promise<{ accepted: boolean; replay: boolean }>;
}
/** Transport serialization is never signed or hashed. All authentication uses format frames. */
export function sealedWrite(reply: SealedReply, operationId: string, previous: Buffer | null): SealedWrite {
  const { genesis, transitions, ...current } = reply;
  return {
    operationId,
    prevHeadHash: previous ? binary(previous) : null,
    setId: binary(reply.roster.setId),
    headHash: binary(framedHash(headBytes(reply.head))),
    headVersion: reply.head.headVersion,
    rosterVersion: reply.roster.rosterVersion,
    payload: encode(current),
    history: {
      genesis: encode(genesis),
      transitions: transitions.slice(-64).map(encode),
      rotateLists: [],
    },
  };
}
export function sealedRead(
  wire: { payload: ArrayBuffer | null; history: SealedHistoryWire | null },
  cached?: SealedReply,
): SealedReply {
  if (!wire.payload) {
    invariant(cached, 'SECRETS_PIN_LOST', 'The local ciphertext cache is missing.');
    return cached;
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
