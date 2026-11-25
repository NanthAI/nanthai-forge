// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { makeFunctionReference } from 'convex/server';
import { coordinationClient } from './coordination-client.js';
import { deadlineConvexClient } from './network-convex-client.js';
import { networkFetch, networkTimeout } from './network-fetch.js';
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
  /** Waiting proposals this write resolves beyond its own proposal records. */
  resolved?: ArrayBuffer[];
};
/** The mutation arguments: everything else is derived from the payload by the server. */
export type SealedWriteArgs = {
  operationId: string;
  payload: ArrayBuffer;
  genesis: ArrayBuffer | null;
  transition: ArrayBuffer | null;
  resolved?: ArrayBuffer[];
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
  /** How many proposals wait for a holder; absent when none or from older deployments. */
  proposals?: number;
  /** The given names of removed CI machines, which a signed former entry does not carry: display only. */
  formerNames?: { id: ArrayBuffer; name: string }[];
};
export interface SealedTransport {
  read(input: {
    kind: 1 | 2 | 3;
    headHash?: ArrayBuffer;
    rosterVersion?: number;
  }): Promise<SealedReadWire | null>;
  write(
    input: SealedWriteArgs & {
      kind: 1 | 2 | 3;
      /** Slice 5: the read verifier of the one machine entry this write's step adds (src/sealed-machine.ts). */
      machineReader?: { machineId: ArrayBuffer; verifier: ArrayBuffer };
    },
  ): Promise<{ accepted: boolean; replay: boolean }>;
  /** Design 5.1: post this device's own join request (sealedSecrets:join). */
  join?(input: { kind: 1 | 2 | 3; request: ArrayBuffer }): Promise<{ accepted: boolean; replay: boolean }>;
  /** Gate B2 M3: record this device on its sign-in, so ending the sign-in elsewhere marks it (sealedSecrets:link). */
  link?(input: { kind: 1 | 2 | 3; deviceId: ArrayBuffer }): Promise<{ linked: boolean }>;
  /** Item 6466c6a5: store this device's signed proposal (sealedSecrets:propose). */
  propose?(input: {
    kind: 1 | 2 | 3;
    proposal: ArrayBuffer;
  }): Promise<{ accepted: boolean; replay: boolean }>;
  /** The waiting proposal records (sealedSecrets:proposals). */
  proposals?(input: { kind: 1 | 2 | 3 }): Promise<ArrayBuffer[]>;
  /** Reject waiting proposals without a head write (sealedSecrets:reject). */
  reject?(input: { kind: 1 | 2 | 3; proposalIds: ArrayBuffer[] }): Promise<{ rejected: number }>;
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
  'WORK_CONFLICT',
  'HOSTED_SCHEMA_REJECTED',
  'BAD_ARGUMENT',
]);
const fixedSealedReasons: Record<string, string> = {
  SECRETS_FORMAT_REFUSED: 'the stored record is outside the secret format or its size limits',
  SECRETS_SET_REPLACED: 'this set was replaced; read it again and start over',
  SECRETS_NOT_ALLOWED: 'this device or account is not allowed to make that change here',
  SECRETS_NOT_SET_UP: 'this set is not set up yet',
  WORK_CONFLICT:
    'the proposal is no longer current: it was made before a re-key, was already applied or rejected, or is no longer waiting; list the proposals again or make a new one',
};
/** A storage reply that proves the mutation stored nothing, as a terminal error; null when the outcome is unknown.
 * Convex checks arguments before a mutation runs, so an argument-validation failure (a CLI build whose request
 * shape the deployment does not take) is a refusal, never an unknown outcome to retry for ever. */
export function sealedRefusal(error: unknown): ForgeError | null {
  const code =
    error instanceof ForgeError ? error.code : (error as { data?: { code?: unknown } })?.data?.code;
  if (typeof code === 'string' && refusals.has(code)) {
    // Gate B2 L1: the refusal text is the client's own, fixed per code. A server's wording never reaches a person or
    // an agent (a compromised server could write instructions there); the code names the reason.
    const reason = fixedSealedReasons[code] ?? '';
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
  ...(wire.resolved?.length ? { resolved: wire.resolved } : {}),
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
    propose: input =>
      client.mutation(makeFunctionReference<'mutation'>('sealedSecrets:propose'), { projectId, ...input }),
    proposals: input =>
      client.query(makeFunctionReference<'query'>('sealedSecrets:proposals'), { projectId, ...input }),
    reject: input =>
      client.mutation(makeFunctionReference<'mutation'>('sealedSecrets:reject'), { projectId, ...input }),
  };
}
/** Slice 5: a machine has no Forge sign-in. It reads its set's row with the token its key derives
 * (sealedMachines:read); the reply is verified as a machine before anything opens. */
export function machineSealedTransport(deployment: string, projectId: string) {
  let url: URL;
  try {
    url = new URL(deployment);
  } catch {
    throw new ForgeError('BAD_ARGUMENT', 'Use a Forge deployment URL.');
  }
  invariant(
    (url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) &&
      !url.username &&
      !url.password,
    'BAD_ARGUMENT',
    'Use an HTTPS Forge deployment URL with no credentials.',
  );
  const client = deadlineConvexClient(url.origin, {
    skipConvexDeploymentUrlCheck: true,
    logger: false,
    fetch: (input, init) =>
      networkFetch(input, { ...init, redirect: 'error', signal: networkTimeout(30_000) }, { retries: 1 }),
  });
  return {
    read: (input: {
      kind: 1 | 2 | 3;
      machineId: ArrayBuffer;
      token: ArrayBuffer;
    }): Promise<SealedReadWire | null> =>
      client.query(makeFunctionReference<'query'>('sealedMachines:read'), { projectId, ...input }),
  };
}
export type MachineSealedTransport = ReturnType<typeof machineSealedTransport>;
