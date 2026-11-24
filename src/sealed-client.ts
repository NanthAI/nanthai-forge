// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { randomUUID } from 'node:crypto';
import { deserialize, serialize } from 'node:v8';
import { ForgeError, invariant } from './errors.js';
import { equalBytes, framedHash } from './sealed-format.js';
import { signBytes } from './sealed-keys.js';
import type { StoredDeviceKeys } from './sealed-local.js';
import { resolveSealedOperation } from './sealed-resolve.js';
import { SealedJournal } from './sealed-journal.js';
import { newSealedSet } from './sealed-genesis.js';
import { headBytes, changeBytes, type NameRecord } from './sealed-records.js';
import { verifySealedReply, type SealedReply, type VerifyRequest } from './sealed-verify.js';
import {
  sealedRead,
  sealedRefusal,
  sealedWrite,
  sealedWriteArgs,
  type SealedReadWire,
  type SealedTransport,
} from './sealed-transport.js';
import { requireConfirmedWriter, type JourneyAnchor } from './sealed-anchors.js';
import { afterVerified, firstContactAnchor } from './sealed-auto-client.js';
import { SecretPins } from './sealed-pins.js';
import { makeRoom, nextValueVersion, sealValue } from './sealed-value.js';
import { checkSecretWriteName } from './secret-names.js';
import { findEntry, writeDevice } from './sealed-roster.js';
import { networkFailure } from './network-fetch.js';
import { removeMarkedFirst } from './sealed-unshare.js';

type Verified = NonNullable<Awaited<ReturnType<SealedClient['read']>>>;
/** A copy of the verified state's reply whose head this device signs next. The caller zeroes the state's key. */
export function nextReply(client: SealedClient, state: Verified) {
  const reply: SealedReply = deserialize(serialize(state.reply));
  reply.head = {
    ...reply.head,
    headVersion: reply.head.headVersion + 1,
    prevHeadHash: framedHash(headBytes(state.reply.head)),
    signedAt: Date.now(),
    signerId: client.keys.id,
  };
  return reply;
}
/** Puts `record` (and its ciphertext) in the next head, checks the format bounds, signs the head and verifies it as
 * every reader pinned at `state` will, before anything is sent. */
export function signNext(
  client: SealedClient,
  reply: SealedReply,
  state: Verified | null,
  record: NameRecord,
  stored: Buffer | null,
) {
  reply.ciphertexts = reply.ciphertexts.filter(c => c.name !== record.name);
  if (stored) reply.ciphertexts.push({ name: record.name, stored });
  reply.head.names = reply.head.names.filter(n => n.name !== record.name).concat(record);
  invariant(
    reply.head.names.filter(n => n.kind !== 3).length <= 200 &&
      reply.ciphertexts.reduce((n, c) => n + c.stored.length, 0) <= 256 * 1024,
    'SECRETS_FORMAT_REFUSED',
    'Sealed values exceed the format bounds.',
  );
  reply.head.signature = signBytes(headBytes(reply.head), client.keys.sign);
  const check = verifySealedReply(reply, state?.pin ?? null, {
    ...client.request(),
    firstContact: !state,
    ...(!state ? { anchor: { kind: 'own-genesis' as const, deviceId: client.keys.id } } : {}),
  });
  check.key?.fill(0);
  for (const secret of check.secrets) secret.value.fill(0);
}
export class SealedClient {
  constructor(
    readonly project: string,
    readonly account: string,
    readonly keys: StoredDeviceKeys,
    readonly pins: SecretPins,
    readonly transport: SealedTransport,
    readonly agent: boolean,
    readonly notice: (line: string) => void = () => {},
    /** A person sees stderr on a terminal: kept automatic-share notices are cleared once shown here. */
    readonly terminal = false,
  ) {}
  /** The set this client reads and writes; ChecksClient (src/sealed-checks.ts) is the owner device's Checks view. */
  get kind(): 1 | 2 {
    return 1;
  }
  get setName() {
    return this.kind === 1 ? 'Development' : 'Checks';
  }
  notSetUp() {
    return new ForgeError(
      'SECRETS_NOT_SET_UP',
      `${this.setName} is not set up. The owner runs nforge secret set NAME${this.kind === 2 ? ' --set checks' : ''}.`,
    );
  }
  request(anchor?: JourneyAnchor): VerifyRequest {
    return {
      forgeProjectId: this.project,
      setKind: this.kind,
      // Without a journey anchor, preserve the original creator-only proof: this locally held identity must
      // be the sole genesis entry, and every subsequent transition must chain from it.
      anchor: anchor ?? { kind: 'own-genesis', deviceId: this.keys.id },
      recipient: { id: this.keys.id, enc: this.keys.enc, kind: 1 },
    };
  }
  private async verifyFetched(
    reply: SealedReply,
    current: Awaited<ReturnType<SecretPins['load']>>,
    cached: boolean,
    wire: SealedReadWire,
  ): Promise<Awaited<ReturnType<SealedClient['read']>>> {
    try {
      // Checks has no automatic join: an owner device's first contact is its own genesis (the default anchor).
      const anchor = current || this.kind !== 1 ? undefined : await firstContactAnchor(this, reply, wire);
      const result = await this.pins.verifyAndSave(reply, this.request(anchor), Date.now(), true);
      for (const line of result.notices) this.notice(line);
      if (wire.proposals && !this.agent && this.kind === 1)
        this.notice(
          `${wire.proposals} proposal${wire.proposals === 1 ? ' waits' : 's wait'} in Development: nforge secret proposals`,
        );
      try {
        if (this.kind === 1)
          for (const line of await afterVerified(this, reply, result, current?.pin ?? null, anchor, wire))
            this.notice(line);
      } finally {
        if (cached) result.key?.fill(0);
      }
      return { reply, ...result, key: cached ? undefined : result.key };
    } catch (error) {
      if (error instanceof ForgeError && ['SECRETS_ROLLBACK', 'SECRETS_FORK'].includes(error.code)) {
        const latest = await this.pins.load(this.project, this.kind);
        if (
          current &&
          latest &&
          !framedHash(headBytes(current.pin.head)).equals(framedHash(headBytes(latest.pin.head)))
        )
          return this.read(cached);
      }
      throw error;
    }
  }
  async read(
    cached = false,
  ): Promise<({ reply: SealedReply } & ReturnType<typeof verifySealedReply>) | null> {
    const current = await this.pins.load(this.project, this.kind);
    if (cached && current) {
      // The small response on a hit still rechecks current access; the full bounded row is read server-side.
      const hash = Uint8Array.from(framedHash(headBytes(current.pin.head))).buffer;
      try {
        const wire = await this.transport.read({
          kind: this.kind,
          headHash: hash,
          rosterVersion: current.pin.roster.rosterVersion,
        });
        if (!wire) throw this.notSetUp();
        const reply = sealedRead(wire, current.cache);
        return await this.verifyFetched(reply, current, true, wire);
      } catch (error) {
        // Offline only: authentication/verification failures never silently fall back to cached source.
        if (!networkFailure(error)) throw error;
        const result = verifySealedReply(current.cache, current.pin, this.request());
        result.key?.fill(0);
        return { reply: current.cache, ...result, key: undefined };
      }
    }
    const wire = await this.transport.read({
      kind: this.kind,
      ...(current ? { rosterVersion: current.pin.roster.rosterVersion } : {}),
    });
    if (!wire) return null;
    const reply = sealedRead(wire, current?.cache);
    return this.verifyFetched(reply, current, false, wire);
  }
  async write(name: string, value: Buffer | null, options: { file?: boolean; operationId?: string } = {}) {
    const operationId = options.operationId ?? randomUUID();
    invariant(/^[0-9a-f-]{36}$/i.test(operationId), 'BAD_ARGUMENT', 'Use a UUID operation id.');
    checkSecretWriteName(name, {
      set: this.kind === 1 ? 'development' : 'checks',
      agent: this.agent,
      writeLine: this.notice,
    });
    // Owner decision 3: a person changes Checks values; agents run checks, they never write their secrets.
    invariant(
      this.kind === 1 || !this.agent,
      'PERSON_REQUIRED',
      'A person sets Checks values: run nforge secret set NAME --set checks on a terminal.',
    );
    const journal = new SealedJournal(this.pins.directory, this.pins.lock);
    const identity = { project: this.project, name, removing: value === null, file: Boolean(options.file) };
    let pending = await journal.read(operationId, identity);
    let replaying = Boolean(pending),
      removedMarked = false;
    const unknown = () =>
      new ForgeError(
        'SECRETS_WRITE_UNKNOWN',
        `Secret write outcome is unknown. Run nforge secret list to see the current head, then repeat the change as a new operation if it is missing. Exact-request retry: --operation-id ${operationId}.`,
        undefined,
        { operationId },
      );
    for (;;) {
      if (pending?.state === 'accepted') {
        const current = await this.read(); // Recheck current access using the local creator-only anchor.
        try {
          if (value !== null)
            invariant(
              current &&
                equalBytes(framedHash(headBytes(current.reply.head)), pending.headHash) &&
                equalBytes(current.secrets.find(s => s.name === name)?.value ?? Buffer.alloc(0), value),
              'WORK_OPERATION_REUSED',
              'A confirmed operation cannot be replayed with another value or after its head changed. Use secret resolve to read its receipt, or a new operation for a new change.',
            );
          return { operationId, name, removed: identity.removing, replay: true };
        } finally {
          current?.key?.fill(0);
          for (const secret of current?.secrets ?? []) secret.value.fill(0);
        }
      }
      if (!pending) {
        const state = await this.read();
        // Design 5.5: a person's write first removes the entries Forge marked, with a re-key (once per write).
        if (this.kind === 1 && (await removeMarkedFirst(this, state, removedMarked))) {
          removedMarked = true;
          continue;
        }
        // Item 6466c6a5: an agent never changes or removes an existing value; it asks a person with a proposal.
        if (this.agent && state) {
          const old = state.pin.head.names.find(n => n.name === name);
          if (old || value === null) {
            const { proposeChange } = await import('./sealed-proposal-client.js');
            return proposeChange(this, state, name, value, Boolean(options.file), operationId);
          }
        }
        const previous = state ? framedHash(headBytes(state.reply.head)) : null;
        let reply: SealedReply, key: Buffer;
        if (!state) {
          if (value === null) throw this.notSetUp();
          ({ reply, key } = await this.genesis());
        } else {
          reply = nextReply(this, state);
          key = state.key!;
          for (const secret of state.secrets) secret.value.fill(0);
        }
        try {
          invariant(
            writeDevice(findEntry(reply.roster, this.keys.id), reply.roster.setKind),
            'SECRETS_NOT_ALLOWED',
            `Only a device of ${this.kind === 1 ? 'a write member or owner holding Development' : 'an owner holding Checks'} writes its values.`,
          );
          // Gate B2 L7: a write rests on a roster this device confirmed, not one it only trusted on first use. A value
          // sealed into a set a compromised server built for a tofu device would reach that server.
          if (state) requireConfirmedWriter(state.pin);
          const old = reply.head.names.find(n => n.name === name);
          if (value === null && (!old || old.kind === 3)) return { operationId, name, removed: false };
          // Make room before choosing a version, since compaction can raise the floor.
          makeRoom(reply.head, name);
          invariant(
            value === null || old?.kind !== 3 || reply.head.names.filter(n => n.kind !== 3).length < 200,
            'SECRETS_FORMAT_REFUSED',
            'The set exceeds its live-name bound.',
          );
          const record: NameRecord = {
            name,
            kind: value === null ? 3 : options.file ? 2 : 1,
            valueVersion: nextValueVersion(reply.head, name),
            valueEpoch: reply.roster.epoch,
            sealEpoch: reply.roster.epoch,
            ctHash: Buffer.alloc(0),
            valueCommit: Buffer.alloc(0),
            changedBy: this.keys.id,
            changedAt: reply.head.signedAt,
            proposalId: Buffer.alloc(0),
            changeSig: Buffer.alloc(64),
            flags: this.agent ? 4 : 0,
            allowedChecks: [],
          };
          let stored: Buffer | null = null;
          if (value !== null) {
            const sealed = sealValue(
              key,
              {
                projectId: reply.roster.projectId,
                setId: reply.roster.setId,
                epoch: reply.roster.epoch,
                name: record.name,
                kind: record.kind as 1 | 2,
                valueVersion: record.valueVersion,
                valueEpoch: record.valueEpoch,
                sealEpoch: record.sealEpoch,
              },
              value,
            );
            record.ctHash = sealed.ctHash;
            record.valueCommit = sealed.valueCommit;
            stored = sealed.stored;
          }
          record.changeSig = signBytes(changeBytes(reply.head, record), this.keys.sign);
          // Verify before sending; no key or plaintext is retained in the retry journal.
          signNext(this, reply, state, record, stored);
          pending = {
            ...identity,
            state: 'unknown',
            wire: sealedWrite(
              reply,
              operationId,
              state ? { headHash: previous!, rosterVersion: state.reply.roster.rosterVersion } : null,
            ),
          };
          const raced = await journal.retain(operationId, pending);
          if (raced) {
            pending = await journal.read(operationId, identity);
            replaying = true;
            continue;
          }
        } finally {
          key.fill(0);
        }
      }
      if (replaying && value !== null) {
        const check = verifySealedReply(sealedRead(pending.wire), null, {
          ...this.request(),
          firstContact: true,
          anchor: { kind: 'device-head', value: { id: this.keys.id, signPub: this.keys.signPub } },
        });
        try {
          invariant(
            equalBytes(check.secrets.find(s => s.name === name)?.value ?? Buffer.alloc(0), value),
            'WORK_OPERATION_REUSED',
            'This operation already sealed a different value. Use a new operation for a new change.',
          );
        } finally {
          check.key?.fill(0);
          for (const secret of check.secrets) secret.value.fill(0);
        }
      }
      let receipt: { accepted: boolean; replay: boolean };
      try {
        receipt = await this.transport.write({ ...sealedWriteArgs(pending.wire), kind: this.kind });
      } catch (error) {
        const refused = sealedRefusal(error);
        if (refused) {
          await journal.refuse(operationId);
          throw refused;
        }
        throw unknown();
      }
      if (!receipt.accepted) {
        // An earlier unknown request may have succeeded and aged out of the server's event ring.
        if (replaying) throw unknown();
        await journal.refuse(operationId);
        pending = null;
        continue;
      }
      // If compaction fails, preserve the exact request and report its recoverable unknown state.
      try {
        await journal.accept(operationId, pending);
      } catch {
        throw unknown();
      }
      const reply = sealedRead(pending.wire);
      const latest = await this.pins.load(this.project, this.kind);
      if (!latest || latest.pin.head.headVersion <= reply.head.headVersion) {
        const verified = await this.pins.verifyAndSave(
          reply,
          {
            ...this.request(),
            ...(!latest
              ? {
                  anchor: {
                    kind: 'device-head' as const,
                    value: { id: this.keys.id, signPub: this.keys.signPub },
                  },
                }
              : {}),
          },
          Date.now(),
        );
        verified.key?.fill(0);
        for (const secret of verified.secrets) secret.value.fill(0);
      }
      return { operationId, name, removed: value === null, replay: receipt.replay };
    }
  }
  /** The first head of this client's set: Development's genesis; ChecksClient overrides it. */
  async genesis(): Promise<{ reply: SealedReply; key: Buffer }> {
    return newSealedSet(this.project, this.account, this.keys, Date.now());
  }
  resolve(operationId: string, confirmDiscard?: (summary: string) => Promise<boolean>) {
    return resolveSealedOperation(this, operationId, confirmDiscard);
  }
}
