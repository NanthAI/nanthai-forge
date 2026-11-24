// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The proposal commands (Item 6466c6a5): an agent proposes a change to an existing value instead of writing it; a
// person lists the waiting proposals, applies one in a normal signed head write, or rejects it. The server stores and
// drops proposals (convex/sealedSecrets.ts propose, proposals, reject); the trust decisions are made here, on this
// device's verified view, never on what the server says about a proposal.
import { createHash, randomUUID } from 'node:crypto';
import { ForgeError, invariant } from './errors.js';
import { framedHash } from './sealed-format.js';
import { headBytes } from './sealed-records.js';
import { decodeSealedWire, encodeSealedWire } from './sealed-wire.js';
import { decodeSealedProposal } from './sealed-decode.js';
import { checkProposal } from './sealed-proposal-check.js';
import { applyProposal, openProposal, sealProposal } from './sealed-proposal.js';
import { sealedRead, sealedRefusal, sealedWrite, sealedWriteArgs } from './sealed-transport.js';
import { requireConfirmedWriter } from './sealed-anchors.js';
import { makeRoom } from './sealed-value.js';
import { findEntry, sameId, writeDevice } from './sealed-roster.js';
import { deviceFingerprint } from './sealed-join.js';
import { safeSecretName } from './sealed-display.js';
import { removeMarkedFirst } from './sealed-unshare.js';
import { nextReply, signNext, type SealedClient } from './sealed-client.js';
import type { SealedProposal } from './sealed-future-records.js';

type Verified = NonNullable<Awaited<ReturnType<SealedClient['read']>>>;
const hex = (id: Uint8Array) => Buffer.from(id).toString('hex');
const buffer = (id: Uint8Array) => Uint8Array.from(id).buffer;
const wipe = (state: Verified | null) => {
  state?.key?.fill(0);
  for (const secret of state?.secrets ?? []) secret.value.fill(0);
};
const conflict = (message: string) => new ForgeError('WORK_CONFLICT', message);
const OP = { 1: 'add', 2: 'change', 3: 'remove' } as const;
/** Review N4 (eb8eb545): a name that existed before, a removed one included, is proposed; re-adding it is an `add`. */
const OPS = { 1: 'adding', 2: 'a new value for', 3: 'removing' } as const;

function transportOf(client: SealedClient) {
  const { propose, proposals, reject } = client.transport;
  invariant(
    propose && proposals && reject,
    'SECRETS_NOT_ALLOWED',
    'This Forge server does not take secret proposals yet.',
  );
  return { propose, proposals, reject };
}

/** An agent's change or removal of an existing Development value: sealed to the set's inbox key on this device's
 * verified view and stored for a person to apply. Takes ownership of `state` and zeroes it. */
export async function proposeChange(
  client: SealedClient,
  state: Verified,
  name: string,
  value: Buffer | null,
  file: boolean,
  operationId: string,
) {
  try {
    const old = state.pin.head.names.find(n => n.name === name);
    if (value === null && (!old || old.kind === 3)) return { operationId, name, removed: false };
    const { proposal, r } = sealProposal({
      pin: state.pin,
      proposer: { id: client.keys.id, sign: client.keys.sign },
      name,
      value,
      file,
      now: Date.now(),
    });
    // Recognising an adopted value by r is not offered yet, so it is not kept.
    r.fill(0);
    try {
      await transportOf(client).propose({ kind: 1, proposal: buffer(encodeSealedWire(proposal)) });
    } catch (error) {
      throw sealedRefusal(error) ?? error;
    }
    const id = hex(proposal.proposalId);
    client.notice(
      `Proposed ${OPS[proposal.op]} ${safeSecretName(name)}; a person applies it with nforge secret apply ${id.slice(0, 8)}.`,
    );
    return { operationId, name, removed: false, proposed: id, op: OP[proposal.op] };
  } finally {
    wipe(state);
  }
}

/** `hash` is the SHA-256 of the exact bytes the server listed: apply signs only the proposal a person was shown. */
type Listed = { id: string; proposal: SealedProposal | null; problem?: string; hash: Buffer };
async function waiting(client: SealedClient, state: Verified): Promise<Listed[]> {
  const rows = await transportOf(client).proposals({ kind: 1 });
  const view = { roster: state.reply.roster, head: state.reply.head, revoked: state.reply.revoked };
  return rows.map(row => {
    let p: SealedProposal | null = null;
    const hash = createHash('sha256').update(new Uint8Array(row)).digest();
    try {
      p = decodeSealedProposal(decodeSealedWire(new Uint8Array(row)));
      checkProposal(view, p);
      return { id: hex(p.proposalId), proposal: p, hash };
    } catch (error) {
      return {
        id: p ? hex(p.proposalId) : '?',
        proposal: p,
        problem: error instanceof ForgeError ? error.code : 'SECRETS_FORMAT_REFUSED',
        hash,
      };
    }
  });
}
function pick(list: Listed[], prefix: string) {
  invariant(
    /^[0-9a-f]{8,32}$/i.test(prefix),
    'BAD_ARGUMENT',
    'Name a proposal by at least 8 hex characters.',
  );
  const found = list.filter(p => p.id.startsWith(prefix.toLowerCase()));
  invariant(
    found.length < 2,
    'BAD_ARGUMENT',
    'More than one proposal starts with this; use more characters.',
  );
  if (!found.length) throw conflict('No waiting proposal has this id. List the proposals again.');
  return found[0]!;
}

/** The waiting proposals as lines: id, operation, safe name, proposer fingerprint and age. Never a value. */
export async function listProposals(client: SealedClient) {
  const state = await client.read();
  try {
    invariant(
      state,
      'SECRETS_NOT_SET_UP',
      'Development is not set up. The owner runs nforge secret set NAME.',
    );
    const now = Date.now();
    return (await waiting(client, state)).map(({ id, proposal: p, problem }) =>
      p
        ? `${id.slice(0, 8)}\t${OP[p.op]}\t${safeSecretName(p.name)}\tfp ${deviceFingerprint(p.proposerId)}\t${Math.max(0, Math.round((now - p.proposedAt) / 60000))} min ago${problem ? `\tnot valid (${problem})` : ''}`
        : `${id}\tnot valid (${problem})`,
    );
  } finally {
    wipe(state);
  }
}

/** What a person approves before apply signs: operation, name, kind, proposer, age and the full id (review F1). */
function applySummary(p: SealedProposal, now: number) {
  return `Apply ${OP[p.op]} ${safeSecretName(p.name)} (${p.kind === 2 ? 'file' : p.kind === 1 ? 'env' : 'removal'}) from fp ${deviceFingerprint(p.proposerId)}, proposed ${Math.max(0, Math.round((now - p.proposedAt) / 60000))} min ago, id ${hex(p.proposalId)}?`;
}

/** A person applies a waiting proposal in a signed head write on its fresh verified view (Gate B2 L7: a confirmed,
 * not trusted-on-first-use, writer). A proposal this device already applied or rejected is refused from its own
 * journal (L1), whatever the server lists. `confirm` shows the person `applySummary` and must say yes before anything
 * is signed; every attempt then signs only the proposal with that full id and the same listed bytes, so a proposal
 * the proposer replaced after the prompt is a conflict (review F1). Retries a lost compare-and-swap race up to three
 * times. */
export async function applyWaiting(
  client: SealedClient,
  prefix: string,
  confirm?: (summary: string) => Promise<boolean>,
) {
  invariant(
    !client.agent && confirm,
    'PERSON_REQUIRED',
    'A person applies a proposal: run nforge secret apply on a terminal.',
  );
  let removedMarked = false,
    shown: { id: string; hash: Buffer } | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    const state = await client.read();
    if (await removeMarkedFirst(client, state, removedMarked)) {
      removedMarked = true;
      attempt--;
      continue;
    }
    let key: Buffer | undefined, opened: ReturnType<typeof openProposal> | undefined;
    try {
      invariant(
        state,
        'SECRETS_NOT_SET_UP',
        'Development is not set up. The owner runs nforge secret set NAME.',
      );
      requireConfirmedWriter(state.pin);
      invariant(
        writeDevice(findEntry(state.reply.roster, client.keys.id), state.reply.roster.setKind),
        'SECRETS_NOT_ALLOWED',
        'Only a device of a write member or owner holding Development applies a proposal.',
      );
      const chosen = pick(await waiting(client, state), shown?.id ?? prefix);
      if ((await client.pins.resolvedProposals(client.project, 1)).some(id => hex(id) === chosen.id))
        throw conflict(
          `This proposal was already applied or rejected on this device. Reject it: nforge secret reject ${chosen.id.slice(0, 8)}.`,
        );
      if (chosen.problem || !chosen.proposal)
        throw new ForgeError(
          chosen.problem ?? 'SECRETS_FORMAT_REFUSED',
          `This proposal is not valid; reject it: nforge secret reject ${chosen.id.slice(0, 8)}.`,
        );
      if (!shown) {
        if (!(await confirm!(applySummary(chosen.proposal, Date.now()))))
          throw new ForgeError('CANCELLED', 'Nothing was applied.');
        shown = { id: chosen.id, hash: chosen.hash };
      } else if (!chosen.hash.equals(shown.hash))
        throw conflict('This proposal changed after you confirmed it. List the proposals again.');
      const previous = framedHash(headBytes(state.reply.head));
      const reply = nextReply(client, state);
      key = state.key!;
      for (const secret of state.secrets) secret.value.fill(0);
      const view = { roster: reply.roster, head: reply.head, key, revoked: state.reply.revoked };
      opened = openProposal(view, chosen.proposal);
      makeRoom(reply.head, opened.proposal.name);
      const out = applyProposal(
        view,
        opened,
        { id: client.keys.id, sign: client.keys.sign },
        reply.head.signedAt,
      );
      signNext(client, reply, state, out.record, out.stored);
      const wire = sealedWrite(reply, randomUUID(), {
        headHash: previous,
        rosterVersion: state.reply.roster.rosterVersion,
      });
      // A kept record names its proposal; an adopted one does not, so the write names it as resolved.
      if (out.mode === 'adopted') wire.resolved = [buffer(opened.proposal.proposalId)];
      let receipt: { accepted: boolean };
      try {
        receipt = await client.transport.write({ ...sealedWriteArgs(wire), kind: 1 });
      } catch (error) {
        const refused = sealedRefusal(error);
        if (refused) throw refused;
        throw new ForgeError(
          'SECRETS_WRITE_UNKNOWN',
          'The outcome of applying this proposal is unknown. Run nforge secret proposals: a proposal no longer listed was applied or rejected.',
        );
      }
      if (!receipt.accepted) continue;
      await client.pins.rememberProposals(client.project, 1, [Buffer.from(opened.proposal.proposalId)]);
      const verified = await client.pins.verifyAndSave(sealedRead(wire), client.request(), Date.now());
      wipe(verified as Verified);
      return { id: chosen.id, name: opened.proposal.name, mode: out.mode, op: OP[opened.proposal.op] };
    } finally {
      key?.fill(0);
      opened?.r.fill(0);
      opened?.value.fill(0);
      if (!key) wipe(state);
    }
  }
  throw conflict('Development changed while applying. List the proposals again.');
}

/** Rejects a waiting proposal without a head write. The server allows it from a write device of the proposer's own
 * account (a withdrawal) or of a person on the roster, and refuses otherwise. */
export async function rejectWaiting(client: SealedClient, prefix: string) {
  const state = await client.read();
  try {
    invariant(
      state,
      'SECRETS_NOT_SET_UP',
      'Development is not set up. The owner runs nforge secret set NAME.',
    );
    const chosen = pick(await waiting(client, state), prefix);
    // Review N3 (eb8eb545): rejecting another device's proposal takes the same trust as applying one.
    if (!chosen.proposal || !sameId(chosen.proposal.proposerId, client.keys.id)) {
      invariant(
        !client.agent,
        'PERSON_REQUIRED',
        'An agent withdraws only its own proposals; a person rejects the others.',
      );
      requireConfirmedWriter(state.pin);
      invariant(
        writeDevice(findEntry(state.reply.roster, client.keys.id), state.reply.roster.setKind),
        'SECRETS_NOT_ALLOWED',
        'Only a device of a write member or owner holding Development rejects another device’s proposal.',
      );
    }
    const id = Buffer.from(chosen.id, 'hex');
    try {
      await transportOf(client).reject({ kind: 1, proposalIds: [buffer(id)] });
    } catch (error) {
      throw sealedRefusal(error) ?? error;
    }
    await client.pins.rememberProposals(client.project, 1, [id]);
    return { id: chosen.id, name: chosen.proposal?.name };
  } finally {
    wipe(state);
  }
}
