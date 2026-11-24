// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Slice 5 review F3: `nforge secret machine rm CODE --set checks`. One owner-signed Checks step removes the machine
// entry and re-keys (src/sealed-unshare.ts removalReply), so the removed key opens nothing written from then on; the
// same mutation deletes the machine's reader (convex/sealedMachines.ts storeMachineReaders), so Forge stops serving
// it at once. What the key could already open is the rotate list, read from the signed roster's former list.
// Journalled like `machine add`; the journal fixes the full machine id at the first send (review 5b51e7f3).
import { randomUUID } from 'node:crypto';
import { ForgeError, invariant } from './errors.js';
import { framedHash } from './sealed-format.js';
import { displayText, headBytes, type Entry } from './sealed-records.js';
import { sameId } from './sealed-roster.js';
import { sealedRead, sealedRefusal, sealedWrite, sealedWriteArgs } from './sealed-transport.js';
import { verifySealedReply } from './sealed-verify.js';
import { SealedJournal } from './sealed-journal.js';
import { liveNames, removalReply } from './sealed-unshare.js';
import { requireOwner, type ChecksClient } from './sealed-checks.js';

type Verified = NonNullable<Awaited<ReturnType<ChecksClient['read']>>>;
type Target = { id: Buffer; label: string };
const discard = (result: { key?: Buffer | undefined; secrets: { value: Buffer }[] } | null | undefined) => {
  result?.key?.fill(0);
  for (const secret of result?.secrets ?? []) secret.value.fill(0);
};
const hex = (id: Buffer) => id.toString('hex');
/** CODE is the machine id `machine add` printed (8 or more hex characters, or all 32) or its label. */
const selects = (code: string) => {
  const c = code.trim().toLowerCase();
  return (id: Buffer, label?: string) =>
    (/^[0-9a-f]{8,32}$/.test(c) && hex(id).startsWith(c)) ||
    (label !== undefined && label.toLowerCase() === c);
};
const describe = (entries: readonly Entry[]) =>
  entries.length
    ? entries.map(e => `${displayText(e.displayName)} (id ${hex(e.id).slice(0, 8)})`).join(', ')
    : 'none';

export type MachineRemoval = {
  /** The label the machine had when it was removed; empty when this device only learns that it is gone. */
  label: string;
  machineId: string;
  operationId: string;
  /** Names the removed key could open, to rotate at their provider (names only). */
  rotate: string[];
  /** True when the machine was already gone: a repeat after an unknown outcome, or a finished operation. */
  already: boolean;
};

export async function removeMachine(
  checks: ChecksClient,
  code: string,
  options: { operationId?: string } = {},
): Promise<MachineRemoval> {
  invariant(code.trim().length > 0, 'BAD_ARGUMENT', 'Name the machine by the id machine add printed.');
  let operationId = options.operationId ?? randomUUID();
  invariant(/^[0-9a-f-]{36}$/i.test(operationId), 'BAD_ARGUMENT', 'Use a UUID operation id.');
  invariant(
    !checks.agent,
    'PERSON_REQUIRED',
    'A person removes a machine: run this command on a terminal, not through an agent.',
  );
  // A supplied operation id only repeats a request this device kept; it never starts a removal.
  let supplied = options.operationId !== undefined;
  const journal = new SealedJournal(checks.pins.directory, checks.pins.lock);
  // The code is not in the identity: the journal holds the machine id the first send resolved it to.
  const identity = { project: checks.project, name: 'machine rm', removing: true, file: false };
  /** Fixed once: the full id of the machine the person named. Every later step finds it by this id alone. */
  let target: Target | null = null;
  const unknown = () =>
    new ForgeError(
      'SECRETS_WRITE_UNKNOWN',
      `Removing the machine has an unknown outcome. Repeat the same operation; it removes the machine at most once and says when it is gone: nforge secret machine rm ${target ? hex(target.id) : 'ID'} --set checks --operation-id ${operationId}`,
      undefined,
      { operationId },
    );
  /** The machine is gone from the verified roster: what its key could open comes from its signed former entry. */
  const gone = (state: Verified, id: Buffer, label: string): MachineRemoval | null => {
    if (state.pin.roster.entries.some(e => e.entryKind === 2 && sameId(e.id, id))) return null;
    const former = state.pin.roster.former.find(f => f.signPub.length === 0 && sameId(f.deviceId, id));
    return {
      label,
      machineId: hex(id),
      operationId,
      rotate: former ? liveNames(state.pin.head, former.lastEpoch) : [],
      already: true,
    };
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    let pending = await journal.read(operationId, identity);
    if (pending) {
      const kept = pending.target;
      invariant(kept, 'WORK_OPERATION_REUSED', 'This operation already names another secret change.');
      target = { id: Buffer.from(kept.id, 'hex'), label: kept.label };
      invariant(
        selects(code)(target.id, target.label),
        'WORK_OPERATION_REUSED',
        'This operation removed or was removing another machine. Use the id the first command named.',
      );
    } else if (supplied) {
      throw new ForgeError(
        'NOT_FOUND',
        'This device no longer keeps that removal, so nothing was sent. Run nforge secret machine rm ID --set checks without --operation-id: it says when the machine is already gone, and otherwise removes it.',
      );
    }
    if (pending?.state === 'accepted') {
      // This operation went through earlier: report it again from the current verified view.
      const state = await checks.read();
      invariant(state, 'SECRETS_NOT_SET_UP', 'Checks is not set up.');
      try {
        const done = gone(state, target!.id, target!.label);
        invariant(
          done,
          'WORK_OPERATION_REUSED',
          'This machine is in Checks again. Remove it as a new operation.',
        );
        return done;
      } finally {
        discard(state);
      }
    }
    const replaying = Boolean(pending);
    let ownRotate: string[] | null = null;
    if (!pending) {
      const state = await checks.read();
      invariant(state, 'SECRETS_NOT_SET_UP', 'Checks is not set up; there is no machine to remove.');
      try {
        requireOwner(checks, state.pin);
        const roster = state.pin.roster;
        const machines = roster.entries.filter(e => e.entryKind === 2);
        // Resolved once. After a lost compare-and-swap the same id is looked up again, never the code.
        const named: Entry[] = target
          ? machines.filter(e => sameId(e.id, target!.id))
          : machines.filter(e => selects(code)(e.id, e.displayName));
        if (!named.length) {
          const known =
            target ??
            // A repeat by id of a removal this roster still remembers (a machine has no label there).
            ((found: Target[]) => (found.length === 1 ? found[0]! : null))(
              roster.former
                .filter(f => f.signPub.length === 0 && selects(code)(f.deviceId))
                .map(f => ({ id: f.deviceId, label: '' })),
            );
          const done = known && gone(state, known.id, known.label);
          invariant(
            done,
            'BAD_ARGUMENT',
            `No machine in Checks matches that id or label; nothing was removed. Machines: ${describe(machines)}. Name one by its id: nforge secret machine rm ID --set checks.`,
          );
          return done;
        }
        invariant(
          named.length === 1,
          'BAD_ARGUMENT',
          `That names more than one machine; nothing was removed. Use more of the id: ${describe(named)}.`,
        );
        const entry: Entry = named[0]!;
        target = { id: entry.id, label: entry.displayName };
        const reply = removalReply(checks, state, [entry], {
          development: checks.request().development!.roster,
        });
        discard(verifySealedReply(reply, state.pin, checks.request()));
        pending = {
          ...identity,
          state: 'unknown',
          target: { id: hex(entry.id), label: entry.displayName },
          wire: sealedWrite(reply, operationId, {
            headHash: framedHash(headBytes(state.pin.head)),
            rosterVersion: roster.rosterVersion,
          }),
        };
        const raced = await journal.retain(operationId, pending);
        if (raced) {
          attempt--;
          continue;
        }
        // Every live value was sealed under the key the machine held.
        ownRotate = liveNames(state.pin.head, roster.epoch);
      } finally {
        discard(state);
      }
    }
    let receipt: { accepted: boolean };
    try {
      receipt = await checks.transport.write({ ...sealedWriteArgs(pending!.wire), kind: 2 });
    } catch (error) {
      const refused = sealedRefusal(error);
      if (refused) {
        await journal.refuse(operationId);
        throw refused;
      }
      throw unknown();
    }
    if (!receipt.accepted) {
      // The journalled request lost its compare-and-swap, or went through earlier and aged out of the server's
      // event ring. The verified roster says which: gone means removed (and the receipt stays under this id); still
      // there means build it again, for the same machine id.
      const state = await checks.read();
      invariant(state, 'SECRETS_NOT_SET_UP', 'Checks is not set up.');
      try {
        const done = gone(state, target!.id, target!.label);
        if (done) {
          if (replaying) await journal.accept(operationId, pending!);
          else await journal.refuse(operationId);
          return done;
        }
        await journal.refuse(operationId);
      } finally {
        discard(state);
      }
      operationId = randomUUID();
      supplied = false;
      continue;
    }
    try {
      await journal.accept(operationId, pending!);
    } catch {
      throw unknown();
    }
    const reply = sealedRead(pending!.wire);
    const latest = await checks.pins.load(checks.project, 2);
    if (!latest || latest.pin.head.headVersion <= reply.head.headVersion)
      discard(await checks.pins.verifyAndSave(reply, checks.request(), Date.now()));
    if (ownRotate)
      return {
        label: target!.label,
        machineId: hex(target!.id),
        operationId,
        rotate: ownRotate,
        already: false,
      };
    // A replayed request the server confirmed: the verified roster now holds the removal.
    const state = await checks.read();
    invariant(state, 'SECRETS_NOT_SET_UP', 'Checks is not set up.');
    try {
      const done = gone(state, target!.id, target!.label);
      invariant(done, 'SECRETS_WRITE_UNKNOWN', 'Checks still lists the machine; run the command again.');
      return { ...done, already: false };
    } finally {
      discard(state);
    }
  }
  throw new ForgeError('SECRETS_WRITE_UNKNOWN', 'Checks kept changing; run the command again.');
}
