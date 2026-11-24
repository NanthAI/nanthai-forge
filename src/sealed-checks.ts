// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Slice 5 (design 5.6, 5.7): the owner device's Checks set. Holders are full owner devices and CI machines only; a
// member is never a Checks recipient. Development names the Checks set through its signed `checksPointer`.
import { randomUUID } from 'node:crypto';
import { ForgeError, invariant } from './errors.js';
import { framedHash } from './sealed-format.js';
import { signBytes, wrapSetKey } from './sealed-keys.js';
import {
  displayText,
  headBytes,
  rosterBytes,
  type Delta,
  type Entry,
  type Roster,
} from './sealed-records.js';
import { findEntry, ownerDevice } from './sealed-roster.js';
import {
  pinConfirmation,
  requireConfirmedBase,
  requireConfirmedWriter,
  type JourneyAnchor,
} from './sealed-anchors.js';
import { createTransition } from './sealed-transition.js';
import { newSealedSet } from './sealed-genesis.js';
import { sealedRead, sealedRefusal, sealedWrite, sealedWriteArgs } from './sealed-transport.js';
import { verifySealedReply, type SealedReply, type SecretPin, type VerifyRequest } from './sealed-verify.js';
import { nextReply, SealedClient } from './sealed-client.js';
import { SealedJournal } from './sealed-journal.js';
import {
  encodeMachineBundle,
  machineEntry,
  machineReader,
  operationMachineKeys,
  type MachineKeys,
} from './sealed-machine.js';

type Verified = NonNullable<Awaited<ReturnType<SealedClient['read']>>>;
const discard = (result: { key?: Buffer | undefined; secrets: { value: Buffer }[] } | null | undefined) => {
  result?.key?.fill(0);
  for (const secret of result?.secrets ?? []) secret.value.fill(0);
};
const delta = (changes: Partial<Delta>): Delta => ({
  added: [],
  removed: [],
  roles: [],
  droppedFormer: [],
  newSharingMode: null,
  newChecksPointer: null,
  supersede: null,
  epochBumped: 0,
  ...changes,
});
/** One signed roster step with no value change: the next head, the step, and a wrap for each added recipient (the
 * set key and epoch are unchanged, so existing wraps and values stay). The caller verifies and writes it. */
function stepReply(
  client: SealedClient,
  state: Verified,
  changes: Partial<Delta>,
  options: { development?: SecretPin['roster']; person?: boolean } = {},
) {
  if (changes.added?.length) requireConfirmedBase(state.pin, 'wrap');
  const { roster, transition } = createTransition(state.pin.roster, delta(changes), client.keys, {
    revoked: state.reply.revoked,
    ...options,
  });
  const reply = nextReply(client, state);
  reply.roster = roster;
  reply.transitions = [...reply.transitions, transition].slice(-64);
  reply.wraps = [
    ...reply.wraps,
    ...(changes.added ?? []).map((e: Entry) =>
      wrapSetKey(state.key!, roster, { id: e.id, encPub: e.encPub, kind: e.entryKind }),
    ),
  ];
  reply.proposals = [];
  reply.head = {
    ...reply.head,
    rosterVersion: roster.rosterVersion,
    rosterHash: framedHash(rosterBytes(roster)),
  };
  reply.head.signature = signBytes(headBytes(reply.head), client.keys.sign);
  return reply;
}
/** Write one step built by stepReply; false when another write won the compare-and-swap (read again). */
async function writeStep(client: SealedClient, state: Verified, reply: SealedReply) {
  discard(verifySealedReply(reply, state.pin, client.request()));
  const out = sealedWrite(reply, randomUUID(), {
    headHash: framedHash(headBytes(state.pin.head)),
    rosterVersion: state.pin.roster.rosterVersion,
  });
  let receipt: { accepted: boolean };
  try {
    receipt = await client.transport.write({ ...sealedWriteArgs(out), kind: client.kind });
  } catch (error) {
    throw (
      sealedRefusal(error) ??
      new ForgeError(
        'SECRETS_WRITE_UNKNOWN',
        `The ${client.setName} change outcome is unknown. Run nforge secret list --set checks, then repeat the command.`,
      )
    );
  }
  if (!receipt.accepted) return false;
  discard(await client.pins.verifyAndSave(reply, client.request(), Date.now()));
  return true;
}
export const requireOwner = (client: SealedClient, pin: SecretPin) => {
  invariant(
    !client.agent,
    'PERSON_REQUIRED',
    'A person changes Checks: run this command on a terminal, not through an agent.',
  );
  invariant(
    ownerDevice(findEntry(pin.roster, client.keys.id)),
    'SECRETS_NOT_ALLOWED',
    `Only a full owner device changes Checks; this device is not one in ${pin.roster.setKind === 1 ? 'Development' : 'Checks'}.`,
  );
  requireConfirmedWriter(pin);
};

/** The owner device's Checks view. Every read and write rests on this device's verified Development pin, whose
 * signed pointer must name the Checks set (src/sealed-verify.ts). */
export class ChecksClient extends SealedClient {
  constructor(
    readonly development: SealedClient,
    private trusted: Verified,
  ) {
    super(
      development.project,
      development.account,
      development.keys,
      development.pins,
      development.transport,
      development.agent,
      development.notice,
      development.terminal,
    );
  }
  override get kind(): 2 {
    return 2;
  }
  override request(anchor?: JourneyAnchor): VerifyRequest {
    return {
      ...super.request(anchor),
      development: { roster: this.trusted.pin.roster, confirmed: pinConfirmation(this.trusted.pin) },
      developmentRevoked: this.trusted.reply.revoked,
    };
  }
  /** Design 5.6: the owner device makes the Checks genesis and, first, the Development step that points to it. A
   * Checks pin on this device means Checks existed here; a server that now shows none gets no new set. */
  override async genesis() {
    requireOwner(this, this.trusted.pin);
    invariant(
      !(await this.pins.load(this.project, 2)),
      'SECRETS_NOT_SET_UP',
      'This device trusts a Checks set that Forge no longer shows. Nothing was changed; try again later.',
    );
    const made = newSealedSet(this.project, this.account, this.keys, Date.now(), 2);
    try {
      const pointer = {
        checksSetId: made.reply.roster.setId,
        checksGenesisHash: framedHash(rosterBytes(made.reply.genesis)),
      };
      for (let attempt = 0; attempt < 3; attempt++) {
        const state = attempt ? await this.development.read() : this.trusted;
        if (!state) throw this.development.notSetUp();
        try {
          requireOwner(this, state.pin);
          if (
            await writeStep(
              this.development,
              state,
              stepReply(this.development, state, { newChecksPointer: pointer }),
            )
          ) {
            const now = await this.development.read();
            if (!now) throw this.development.notSetUp();
            discard(now);
            discard(this.trusted);
            this.trusted = now;
            return made;
          }
        } finally {
          if (state !== this.trusted) discard(state);
        }
      }
    } catch (error) {
      made.key.fill(0);
      throw error;
    }
    made.key.fill(0);
    throw new ForgeError('SECRETS_WRITE_UNKNOWN', 'Development kept changing; run the command again.');
  }
  /** The genesis head alone, when Checks is created by a command that sets no value (machine add). */
  async ensure(): Promise<Verified> {
    const current = await this.read();
    if (current) return current;
    const { reply, key } = await this.genesis();
    try {
      const out = sealedWrite(reply, randomUUID(), null);
      try {
        const receipt = await this.transport.write({ ...sealedWriteArgs(out), kind: 2 });
        invariant(
          receipt.accepted,
          'WORK_CONFLICT',
          'Another device created Checks first; run the command again.',
        );
      } catch (error) {
        throw sealedRefusal(error) ?? error;
      }
      discard(await this.pins.verifyAndSave(reply, this.request(), Date.now()));
    } finally {
      key.fill(0);
    }
    const created = await this.read();
    if (!created) throw this.notSetUp();
    return created;
  }
}
/** The owner device's Checks client, from its verified Development view. */
export async function checksClient(development: SealedClient) {
  const state = await development.read();
  if (!state) throw development.notSetUp();
  // Only the signed Development view is kept: its pointer anchors Checks. No Development key or value stays here.
  discard(state);
  return new ChecksClient(development, state);
}
const bundleFor = (keys: MachineKeys, roster: Roster, headFloor: number) =>
  encodeMachineBundle({
    projectId: roster.projectId,
    setId: roster.setId,
    setKind: 2,
    machineId: keys.id,
    enc: keys.enc,
    roster,
    headFloor,
  });
/** Design 5.7: `nforge secret machine add LABEL --set checks`. One owner-signed step adds the machine entry and its
 * wrap, and the same mutation registers the machine's read verifier. Returns the bundle (FORGE_SECRETS_KEY) once;
 * the caller shows it only to a person on a terminal.
 *
 * Review F5: one operation id names the whole add. Its exact request (no key) is journalled before it is sent, and
 * the machine key is derived from this device's key and that id, so repeating the operation after an unknown
 * outcome re-sends the same request and rebuilds the same key: it reconciles, and never adds a second machine. */
export async function addMachine(
  checks: ChecksClient,
  label: string,
  options: { operationId?: string } = {},
) {
  invariant(label.trim().length > 0, 'BAD_ARGUMENT', 'Name the machine, for example ci.');
  let operationId = options.operationId ?? randomUUID();
  invariant(/^[0-9a-f-]{36}$/i.test(operationId), 'BAD_ARGUMENT', 'Use a UUID operation id.');
  invariant(
    !checks.agent,
    'PERSON_REQUIRED',
    'A person changes Checks: run this command on a terminal, not through an agent.',
  );
  const journal = new SealedJournal(checks.pins.directory, checks.pins.lock);
  const identity = { project: checks.project, name: `machine ${label}`, removing: false, file: false };
  for (let attempt = 0; attempt < 3; attempt++) {
    const keys = operationMachineKeys(checks.keys.enc, operationId);
    const unknown = () =>
      new ForgeError(
        'SECRETS_WRITE_UNKNOWN',
        `Adding the machine has an unknown outcome. Repeat the same operation; it adds no second machine and shows the key if the add went through: nforge secret machine add ${displayText(label)} --set checks --operation-id ${operationId}`,
        undefined,
        { operationId },
      );
    try {
      let pending = await journal.read(operationId, identity);
      if (pending?.state === 'accepted') {
        // This operation went through earlier: show the same key again, from the current verified roster.
        const state = await checks.ensure();
        try {
          invariant(
            findEntry(state.pin.roster, keys.id)?.entryKind === 2,
            'WORK_OPERATION_REUSED',
            'This operation added a machine that is no longer in Checks. Add a new one without --operation-id.',
          );
          return {
            machineId: keys.id.toString('hex'),
            operationId,
            bundle: bundleFor(keys, state.pin.roster, state.pin.head.headVersion),
          };
        } finally {
          discard(state);
        }
      }
      const replaying = Boolean(pending);
      if (!pending) {
        const state = await checks.ensure();
        try {
          requireOwner(checks, state.pin);
          const roster = state.pin.roster;
          const entry = machineEntry(keys, label, checks.keys.id, roster.rosterVersion + 1);
          const reply = stepReply(
            checks,
            state,
            { added: [entry] },
            { development: checks.request().development!.roster, person: true },
          );
          // The new key must open what it was given before anything leaves this device.
          discard(
            verifySealedReply(reply, null, {
              forgeProjectId: checks.project,
              setKind: 2,
              machine: true,
              machineAnchor: reply.roster,
              headFloor: reply.head.headVersion,
              recipient: { id: keys.id, enc: keys.enc, kind: 2 },
            }),
          );
          discard(verifySealedReply(reply, state.pin, checks.request()));
          pending = {
            ...identity,
            state: 'unknown',
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
        } finally {
          discard(state);
        }
      }
      const reader = machineReader({ enc: keys.enc, machineId: keys.id });
      let receipt: { accepted: boolean };
      try {
        receipt = await checks.transport.write({
          ...sealedWriteArgs(pending.wire),
          kind: 2,
          machineReader: {
            machineId: Uint8Array.from(reader.machineId).buffer,
            verifier: Uint8Array.from(reader.verifier).buffer,
          },
        });
      } catch (error) {
        const refused = sealedRefusal(error);
        if (refused) {
          await journal.refuse(operationId);
          throw refused;
        }
        throw unknown();
      }
      if (!receipt.accepted) {
        // An earlier unknown request may have gone through and aged out of the server's event ring.
        if (replaying) throw unknown();
        await journal.refuse(operationId);
        operationId = randomUUID();
        continue;
      }
      try {
        await journal.accept(operationId, pending);
      } catch {
        throw unknown();
      }
      const reply = sealedRead(pending.wire);
      const latest = await checks.pins.load(checks.project, 2);
      if (!latest || latest.pin.head.headVersion <= reply.head.headVersion)
        discard(await checks.pins.verifyAndSave(reply, checks.request(), Date.now()));
      return {
        machineId: keys.id.toString('hex'),
        operationId,
        bundle: bundleFor(keys, reply.roster, reply.head.headVersion),
      };
    } finally {
      keys.enc.fill(0);
    }
  }
  throw new ForgeError('SECRETS_WRITE_UNKNOWN', 'Checks kept changing; run the command again.');
}
