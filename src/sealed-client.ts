// SPDX-License-Identifier: Apache-2.0
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
import { sealedRead, sealedWrite, type SealedTransport } from './sealed-transport.js';
import { SecretPins } from './sealed-pins.js';
import { sealValue } from './sealed-value.js';
import { checkSecretWriteName } from './secret-names.js';
import { findEntry, ownerDevice } from './sealed-roster.js';
import { networkFailure } from './network-fetch.js';

export class SealedClient {
  constructor(
    readonly project: string,
    readonly account: string,
    readonly keys: StoredDeviceKeys,
    readonly pins: SecretPins,
    readonly transport: SealedTransport,
    readonly agent: boolean,
    readonly notice: (line: string) => void = () => {},
  ) {}
  request(): VerifyRequest {
    return {
      forgeProjectId: this.project,
      setKind: 1,
      recipient: { id: this.keys.id, enc: this.keys.enc, kind: 1 },
    };
  }
  private async verifyFetched(
    reply: SealedReply,
    current: Awaited<ReturnType<SecretPins['load']>>,
    cached: boolean,
  ): Promise<Awaited<ReturnType<SealedClient['read']>>> {
    try {
      const result = await this.pins.verifyAndSave(reply, this.request(), Date.now());
      if (cached) result.key?.fill(0);
      for (const line of result.notices) this.notice(line);
      return { reply, ...result, key: cached ? undefined : result.key };
    } catch (error) {
      if (error instanceof ForgeError && ['SECRETS_ROLLBACK', 'SECRETS_FORK'].includes(error.code)) {
        const latest = await this.pins.load(this.project, 1);
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
    const current = await this.pins.load(this.project, 1);
    if (cached && current) {
      // The small response on a hit still rechecks current access; the full bounded row is read server-side.
      const hash = Uint8Array.from(framedHash(headBytes(current.pin.head))).buffer;
      try {
        const wire = await this.transport.read({
          kind: 1,
          headHash: hash,
          rosterVersion: current.pin.roster.rosterVersion,
        });
        invariant(
          wire,
          'SECRETS_NOT_SET_UP',
          'Development is not set up. The owner runs nforge secret set NAME.',
        );
        const reply = sealedRead(wire, current.cache);
        return await this.verifyFetched(reply, current, true);
      } catch (error) {
        // Offline only: authentication/verification failures never silently fall back to cached source.
        if (!networkFailure(error)) throw error;
        const result = verifySealedReply(current.cache, current.pin, this.request());
        result.key?.fill(0);
        return { reply: current.cache, ...result, key: undefined };
      }
    }
    const wire = await this.transport.read({
      kind: 1,
      ...(current ? { rosterVersion: current.pin.roster.rosterVersion } : {}),
    });
    if (!wire) return null;
    const reply = sealedRead(wire, current?.cache);
    return this.verifyFetched(reply, current, false);
  }
  async write(name: string, value: Buffer | null, options: { file?: boolean; operationId?: string } = {}) {
    const operationId = options.operationId ?? randomUUID();
    invariant(/^[0-9a-f-]{36}$/i.test(operationId), 'BAD_ARGUMENT', 'Use a UUID operation id.');
    checkSecretWriteName(name, { set: 'development', agent: this.agent, writeLine: this.notice });
    invariant(
      value !== null || !this.agent,
      'PERSON_REQUIRED',
      'Removing a secret needs a person until proposals are available.',
    );
    const journal = new SealedJournal(this.pins.directory, this.pins.lock);
    const identity = { project: this.project, name, removing: value === null, file: Boolean(options.file) };
    let pending = await journal.read(operationId, identity);
    let replaying = Boolean(pending);
    const unknown = () =>
      new ForgeError(
        'SECRETS_WRITE_UNKNOWN',
        `Secret write outcome is unknown. Run nforge secret list to see the current head, then repeat the change as a new operation if it is missing. Exact-request retry: --operation-id ${operationId}.`,
        undefined,
        { operationId },
      );
    for (;;) {
      if (pending?.state === 'accepted') {
        const current = await this.read(); // Recheck current access before returning a local receipt.
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
        const previous = state ? framedHash(headBytes(state.reply.head)) : null;
        let reply: SealedReply, key: Buffer;
        if (!state) {
          invariant(
            value !== null,
            'SECRETS_NOT_SET_UP',
            'Development is not set up. The owner runs nforge secret set NAME.',
          );
          ({ reply, key } = newSealedSet(this.project, this.account, this.keys, Date.now()));
        } else {
          reply = deserialize(serialize(state.reply));
          key = state.key!;
          for (const secret of state.secrets) secret.value.fill(0);
          reply.head = {
            ...reply.head,
            headVersion: reply.head.headVersion + 1,
            prevHeadHash: previous!,
            signedAt: Date.now(),
            signerId: this.keys.id,
          };
        }
        try {
          invariant(
            ownerDevice(findEntry(reply.roster, this.keys.id)),
            'SECRETS_NOT_ALLOWED',
            'This slice writes from an owner device.',
          );
          invariant(
            reply.revoked.length === 0,
            'SECRETS_REKEY_PENDING',
            'A recipient removal needs a re-key before writing.',
          );
          const old = reply.head.names.find(n => n.name === name);
          invariant(
            !this.agent || !old,
            'PERSON_REQUIRED',
            'Changing an existing secret needs a person until proposals are available.',
          );
          if (value === null && (!old || old.kind === 3)) return { operationId, name, removed: false };
          // Make room before assigning a new name's version, so it starts above the resulting floor.
          if (!old && reply.head.names.length >= 400) {
            const tombstone = reply.head.names
              .filter(n => n.kind === 3)
              .sort((a, b) => a.changedAt - b.changedAt)[0];
            invariant(tombstone, 'SECRETS_FORMAT_REFUSED', 'The set has no tombstone to compact.');
            reply.head.names = reply.head.names.filter(n => n !== tombstone);
            reply.head.versionFloor = Math.max(reply.head.versionFloor, tombstone.valueVersion);
          }
          invariant(
            value === null || old?.kind !== 3 || reply.head.names.filter(n => n.kind !== 3).length < 200,
            'SECRETS_FORMAT_REFUSED',
            'The set exceeds its live-name bound.',
          );
          const record: NameRecord = {
            name,
            kind: value === null ? 3 : options.file ? 2 : 1,
            valueVersion: old ? old.valueVersion + 1 : reply.head.versionFloor + 1,
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
          reply.ciphertexts = reply.ciphertexts.filter(c => c.name !== name);
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
            reply.ciphertexts.push({ name, stored: sealed.stored });
          }
          record.changeSig = signBytes(changeBytes(reply.head, record), this.keys.sign);
          reply.head.names = reply.head.names.filter(n => n.name !== name).concat(record);
          invariant(
            reply.head.names.filter(n => n.kind !== 3).length <= 200 &&
              reply.ciphertexts.reduce((n, c) => n + c.stored.length, 0) <= 256 * 1024,
            'SECRETS_FORMAT_REFUSED',
            'Sealed values exceed the format bounds.',
          );
          reply.head.signature = signBytes(headBytes(reply.head), this.keys.sign);
          // Verify before sending; no key or plaintext is retained in the retry journal.
          const check = verifySealedReply(reply, state?.pin ?? null, {
            ...this.request(),
            firstContact: !state,
          });
          check.key?.fill(0);
          for (const secret of check.secrets) secret.value.fill(0);
          pending = { ...identity, state: 'unknown', wire: sealedWrite(reply, operationId, previous) };
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
        receipt = await this.transport.write({ ...pending.wire, kind: 1 });
      } catch (error) {
        const code =
          error instanceof ForgeError ? error.code : (error as { data?: { code?: unknown } })?.data?.code;
        if (
          typeof code === 'string' &&
          [
            'AUTH_REQUIRED',
            'AUTH_EXPIRED',
            'AUTH_REVOKED',
            'AUTH_SCOPE_DENIED',
            'PROJECT_UNAVAILABLE',
            'SECRETS_FORMAT_REFUSED',
            'SECRETS_SET_REPLACED',
            'WORK_OPERATION_REUSED',
            'HOSTED_SCHEMA_REJECTED',
            'BAD_ARGUMENT',
          ].includes(code)
        ) {
          await journal.refuse(operationId);
          throw new ForgeError(code, 'Secret storage refused this operation; local trust was not changed.');
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
      const latest = await this.pins.load(this.project, 1);
      if (!latest || latest.pin.head.headVersion <= reply.head.headVersion) {
        const verified = await this.pins.verifyAndSave(reply, this.request(), Date.now());
        verified.key?.fill(0);
        for (const secret of verified.secrets) secret.value.fill(0);
      }
      return { operationId, name, removed: value === null, replay: receipt.replay };
    }
  }
  resolve(operationId: string, confirmDiscard?: (summary: string) => Promise<boolean>) {
    return resolveSealedOperation(this, operationId, confirmDiscard);
  }
}
