// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { ForgeError, invariant } from './errors.js';
import { equalBytes, forgeSecretId, framedHash } from './sealed-format.js';
import { inboxKeys, unwrapSetKey, verifyBytes, type KeyWrap } from './sealed-keys.js';
import {
  changeBytes,
  headBytes,
  rosterBytes,
  supersedeBytes,
  type Head,
  type Roster,
  type Supersede,
  type Transition,
} from './sealed-records.js';
import { checkRoster, findEntry, ownerDevice, sameId, walkTransition, writeDevice } from './sealed-roster.js';
import { openValue } from './sealed-value.js';
import { secretNameKind } from './secret-names.js';
import { decodeSealedReply } from './sealed-decode.js';
import { safeSecretName } from './sealed-display.js';
import type { SealedProposal } from './sealed-future-records.js';
import {
  automaticJoinAnchor,
  checkpointAnchor,
  codeAnchor,
  deviceHeadAnchor,
  pinConfirmation,
  type CodeAnchor,
  type JourneyAnchor,
  type PinConfirmation,
  walkOnly,
} from './sealed-anchors.js';
import { automaticShareNotice } from './sealed-join.js';

export type SealedReply = {
  v: 1;
  genesis: Roster;
  roster: Roster;
  head: Head;
  transitions: Transition[];
  ciphertexts: { name: string; stored: Buffer }[];
  wraps: KeyWrap[];
  revoked: Buffer[];
  supersede: Supersede | null;
  proposals: SealedProposal[];
  previous?: SealedReply;
  related?: SealedReply[];
};
export type SecretPin = {
  v: 1;
  genesisHash: Buffer;
  roster: Roster;
  head: Head;
  rosterHashes: { version: number; hash: Buffer }[];
  holder: boolean;
  /** GB-08 d4. Absent only on pins written before the flag (read through pinConfirmation). */
  confirmed?: PinConfirmation;
};
export type VerifyRequest = {
  forgeProjectId: string;
  setKind: Roster['setKind'];
  firstContact?: boolean;
  /** The trusted Development pin a Checks read rests on; a `tofu` one is refused as a Checks anchor. */
  development?: Pick<SecretPin, 'roster' | 'confirmed'>;
  checks?: SecretPin;
  developmentRevoked?: Buffer[];
  recipient?: { id: Buffer; enc: Buffer; kind: 1 | 2 | 3 };
  machine?: boolean;
  headFloor?: number;
  machineAnchor?: Roster;
  /** Explicitly supplied by a verified journey; a served roster is never an anchor. */
  anchor?: JourneyAnchor;
};
const hashHead = (h: Head) => framedHash(headBytes(h));
const refuse = (ok: unknown, rule: string) => invariant(ok, 'SECRETS_ROSTER_REFUSED', rule);
const rollback = (ok: unknown, rule: string) => invariant(ok, 'SECRETS_ROLLBACK', rule);

/** The only trust entry point, shared by online, cached, holder and public-only reads.
 * It has no IO and never changes its input pin. Callers commit the result under the pin lock. */
export const verifySealedReply = (reply: SealedReply, pin: SecretPin | null, request: VerifyRequest) =>
  verifyCore(reply, pin, request, null);

/** GB-08 d5 repair mode (Gate B1 C9): every 4.9 check except the final cross-set rule, whose offending
 * owner devices are returned instead. Never pinned and no values: the set key opens only to re-seal. */
export function verifyRepair(reply: SealedReply, pin: SecretPin, request: VerifyRequest) {
  invariant(
    pin &&
      request.recipient?.kind === 1 &&
      request.setKind !== 1 &&
      request.development &&
      !request.machine &&
      !request.machineAnchor,
    'SECRETS_NOT_ALLOWED',
    'Only a Checks or Production holder device with a pin repairs its set.',
  );
  const offending: Buffer[] = [];
  const { pin: view, key, notices } = verifyCore(reply, pin, request, offending);
  return { roster: view.roster, head: view.head, key: key!, offending, notices };
}

function verifyCore(
  reply: SealedReply,
  pin: SecretPin | null,
  request: VerifyRequest,
  repair: Buffer[] | null,
) {
  const noPinAtEntry = !pin,
    carried = pin ? pinConfirmation(pin) : null;
  let key: Buffer | undefined;
  const secrets: { name: string; kind: 'env' | 'file'; value: Buffer }[] = [],
    notices: string[] = [];
  try {
    reply = decodeSealedReply(reply);
    refuse(
      !(request.anchor && request.machineAnchor) &&
        !(request.anchor && request.machine) &&
        !Object.hasOwn(request, 'personCheckpoint') &&
        !Object.hasOwn(request, 'deviceHead'),
      'Supply exactly one typed journey anchor.',
    );
    const projectId = forgeSecretId('project', request.forgeProjectId),
      h = reply.head,
      r = reply.roster;
    if (r.setKind !== 1 && !request.machine) {
      refuse(request.development, 'This set needs a trusted Development roster.');
      // Gate B1 M2: Development trusted on first use never anchors Checks (genesis pointer, replacement proofs).
      refuse(
        request.development?.confirmed !== 'tofu',
        'Checks and Production always need a person: this device trusted Development on first use.',
      );
    }
    invariant(
      reply.v === 1 && h.v === 1 && r.v === 1 && reply.genesis.v === 1 && (!pin || pin.v <= reply.v),
      'SECRETS_FORMAT_REFUSED',
      'Unknown or downgraded secret format.',
    );
    refuse(
      [r, reply.genesis, h].every(
        record =>
          sameId(record.projectId, projectId) &&
          record.setKind === request.setKind &&
          sameId(record.setId, r.setId),
      ),
      'Secret identity differs from the requested project or kind.',
    );
    const code: CodeAnchor | null = request.anchor?.kind === 'code' ? request.anchor.value : null;
    if (code) codeAnchor(reply, code);
    const genesisHash = framedHash(rosterBytes(reply.genesis));
    refuse(reply.genesis.rosterVersion === 1, 'Genesis record is not version one.');
    checkRoster(reply.genesis);
    let anchor = pin?.roster ?? request.machineAnchor;
    if (request.machine)
      invariant(
        request.machineAnchor || pin,
        'SECRETS_PIN_LOST',
        'Machine verification needs its bundle roster.',
      );
    if (anchor)
      refuse(
        sameId(anchor.projectId, projectId) && anchor.setKind === request.setKind,
        'Trusted anchor belongs to another project or kind.',
      );
    if (pin && (!sameId(pin.roster.setId, r.setId) || !sameId(pin.genesisHash, genesisHash))) {
      const s = reply.supersede;
      invariant(
        s && reply.previous,
        'SECRETS_SET_REPLACED',
        'This project shows a different secret set. Confirm it with a holder.',
      );
      const publicRequest = { ...request };
      delete publicRequest.recipient;
      // The old set is checked against its pin; a code anchor names the new set only.
      delete publicRequest.anchor;
      let old: SecretPin;
      try {
        old = verifySealedReply(
          reply.previous!,
          pin,
          request.setKind === 2
            ? {
                ...publicRequest,
                development: {
                  roster: {
                    ...request.development!.roster,
                    checksPointer: { checksSetId: pin.roster.setId, checksGenesisHash: pin.genesisHash },
                  },
                },
              }
            : publicRequest,
        ).pin;
      } catch {
        throw new ForgeError('SECRETS_SET_REPLACED', 'Replacement does not extend the trusted old set.');
      }
      const signer = findEntry(old.roster, s!.signerId);
      invariant(
        s!.oldRosterVersion >= pin.roster.rosterVersion &&
          s!.oldRosterVersion === old.roster.rosterVersion &&
          sameId(s!.oldRosterHash, framedHash(rosterBytes(old.roster))) &&
          sameId(s!.oldHeadHash, hashHead(old.head)) &&
          sameId(s!.projectId, projectId) &&
          s!.setKind === request.setKind &&
          sameId(s!.oldSetId, pin.roster.setId) &&
          sameId(s!.oldGenesisHash, pin.genesisHash) &&
          sameId(s!.newSetId, r.setId) &&
          sameId(s!.newGenesisHash, genesisHash) &&
          ownerDevice(signer) &&
          !reply.previous!.revoked.some(id => sameId(id, s!.signerId)) &&
          verifyBytes(supersedeBytes(s!), s!.signature, signer!.signPub),
        'SECRETS_SET_REPLACED',
        'Replacement does not extend the trusted old set.',
      );
      anchor = reply.genesis;
      pin = null;
    }
    if (request.setKind === 2 && !request.machine) {
      const pointer = request.development?.roster.checksPointer;
      invariant(
        pointer && sameId(pointer.checksSetId, r.setId) && sameId(pointer.checksGenesisHash, genesisHash),
        'SECRETS_SET_REPLACED',
        'Development names a different Checks set. Confirm it with a holder.',
      );
    }
    if (noPinAtEntry && request.anchor) {
      switch (request.anchor.kind) {
        case 'own-genesis':
          refuse(
            sameId(reply.genesis.entries[0]!.id, request.anchor.deviceId) &&
              (!request.recipient || sameId(request.recipient.id, request.anchor.deviceId)),
            'Holder first contact requires this device to have created the set genesis.',
          );
          anchor = reply.genesis;
          break;
        case 'checks-genesis':
          refuse(request.setKind === 2 && request.development, 'Checks needs a trusted Development anchor.');
          anchor = reply.genesis;
          break;
        case 'person-checkpoint':
          anchor = checkpointAnchor(reply, request.anchor.value);
          break;
        case 'device-head':
          anchor = deviceHeadAnchor(reply, request.anchor.value);
          break;
        case 'code':
          anchor = code!.roster;
          break;
        case 'automatic-join':
          anchor = automaticJoinAnchor(reply, request, request.anchor.value);
          break;
        default:
          refuse(false, 'Unknown journey anchor.');
      }
    }
    const base: PinConfirmation = code
      ? 'code'
      : request.machine
        ? 'machine'
        : (carried ??
          // Gate B1 M2: trust on first use through this device's own Automatic join. A rebuild from this device's
          // own head keeps it when its signed entry was added automatically (the old pin is unreadable then).
          (request.anchor?.kind === 'automatic-join' ||
          (request.anchor?.kind === 'device-head' && findEntry(r, request.anchor.value.id)?.how === 3)
            ? 'tofu'
            : // own-genesis without a recipient proves nothing about this device's keys.
              !request.anchor ||
                request.anchor.kind === 'checks-genesis' ||
                (request.anchor.kind === 'own-genesis' && !request.recipient)
              ? 'none'
              : 'holder'));
    // GB-08 d4: a wrap is never opened on a Checks view reached only by the walk from genesis.
    invariant(
      r.setKind === 1 || !request.recipient || base !== 'none',
      'SECRETS_CODE_NEEDED',
      walkOnly('wrap'),
    );
    if (noPinAtEntry && request.recipient?.kind === 3)
      invariant(
        request.anchor?.kind === 'person-checkpoint',
        'SECRETS_PIN_TOO_OLD',
        'A passkey contact needs its signed person checkpoint. Confirm with a holder.',
      );
    if (!anchor) {
      invariant(
        request.firstContact,
        'SECRETS_PIN_LOST',
        'Secret trust is missing. Run nforge secret repin.',
      );
      refuse(false, 'First contact needs an explicit verified journey anchor.');
    }
    invariant(anchor, 'SECRETS_ROSTER_REFUSED', 'First contact needs an explicit verified journey anchor.');
    rollback(r.rosterVersion >= anchor.rosterVersion, 'Roster is older than the pin.');
    invariant(
      r.rosterVersion - anchor.rosterVersion <= 64,
      'SECRETS_PIN_TOO_OLD',
      'Secret roster is beyond the retained history. Confirm with a holder.',
    );
    const hashes = [
      ...(pin?.rosterHashes ?? [{ version: anchor.rosterVersion, hash: framedHash(rosterBytes(anchor)) }]),
    ];
    let verified = anchor;
    while (verified.rosterVersion < r.rosterVersion) {
      const next = reply.transitions.find(t => t.fromVersion === verified.rosterVersion);
      invariant(next, 'SECRETS_PIN_TOO_OLD', 'Secret roster history has a gap. Confirm with a holder.');
      if (next.delta.supersede) {
        const s = next.delta.supersede,
          pointer = next.delta.newChecksPointer;
        const proof = reply.related?.find(old => sameId(old.roster.setId, s.oldSetId));
        const old = proof
          ? verifySealedReply(proof, request.checks ?? null, {
              forgeProjectId: request.forgeProjectId,
              setKind: 2,
              development: { roster: verified },
              ...(!request.checks ? { anchor: { kind: 'checks-genesis' as const } } : {}),
            }).pin
          : request.checks;
        const oldSigner = old && findEntry(old.roster, s.signerId);
        refuse(
          r.setKind === 1 &&
            pointer &&
            old &&
            s.setKind === 2 &&
            sameId(s.projectId, projectId) &&
            sameId(s.oldSetId, old.roster.setId) &&
            sameId(s.oldGenesisHash, old.genesisHash) &&
            s.oldRosterVersion === old.roster.rosterVersion &&
            sameId(s.oldRosterHash, framedHash(rosterBytes(old.roster))) &&
            sameId(s.oldHeadHash, hashHead(old.head)) &&
            sameId(s.newSetId, pointer.checksSetId) &&
            sameId(s.newGenesisHash, pointer.checksGenesisHash) &&
            ownerDevice(oldSigner) &&
            !proof?.revoked.some(id => sameId(id, s.signerId)) &&
            verifyBytes(supersedeBytes(s), s.signature, oldSigner!.signPub),
          'Checks pointer replacement lacks a forward owner-signed record.',
        );
      }
      // GB-08 d2: the cross-set Checks owner rule applies to the final roster below, not to each step.
      verified = walkTransition(verified, next, reply.revoked);
      // Guard 3: every holder's notice of an automatic share is derived from the signed step it walked.
      for (const added of next.delta.added)
        if (added.how === 3) notices.push(automaticShareNotice(added, next.signerId));
      hashes.push({ version: verified.rosterVersion, hash: framedHash(rosterBytes(verified)) });
    }
    invariant(
      sameId(framedHash(rosterBytes(verified)), framedHash(rosterBytes(r))),
      'SECRETS_FORK',
      'Current roster differs from the trusted chain.',
    );
    // A code confirms what the holder signed; the served chain, from a pin or from the anchor, passes through it.
    if (code)
      rollback(r.rosterVersion >= code.roster.rosterVersion, 'Roster is older than the code-confirmed one.');
    if (code)
      invariant(
        hashes.some(
          e =>
            e.version === code.roster.rosterVersion && sameId(e.hash, framedHash(rosterBytes(code.roster))),
        ),
        hashes.some(e => e.version === code.roster.rosterVersion) ? 'SECRETS_FORK' : 'SECRETS_PIN_TOO_OLD',
        "The code-confirmed roster is not on this device's trusted chain.",
      );
    if (repair) {
      checkRoster(r);
      const development = request.development!.roster;
      for (const e of r.entries)
        if (
          e.entryKind === 1 &&
          !development.entries.some(d => ownerDevice(d) && sameId(d.accountId, e.accountId))
        )
          repair.push(e.id);
      invariant(
        repair.length,
        'SECRETS_NOT_ALLOWED',
        'This roster keeps the cross-set rule; nothing to repair.',
      );
    } else checkRoster(r, request.development?.roster);
    const headHash = hashHead(h),
      pinnedHash = pin ? hashHead(pin.head) : null;
    const sameHead = !!pin && h.headVersion === pin.head.headVersion && sameId(headHash, pinnedHash!);
    const adjacent = !!pin && h.headVersion === pin.head.headVersion + 1;
    const signer = findEntry(r, h.signerId);
    refuse(
      writeDevice(signer, r.setKind) &&
        verifyBytes(headBytes(h), h.signature, signer!.signPub) &&
        (sameHead || !reply.revoked.some(id => sameId(id, h.signerId))),
      'Head signer lacks current write authority.',
    );
    refuse(
      h.rosterVersion === r.rosterVersion &&
        sameId(h.rosterHash, framedHash(rosterBytes(r))) &&
        h.epoch === r.epoch,
      'Head does not match the verified roster.',
    );
    rollback(
      h.headVersion >= (pin?.head.headVersion ?? request.headFloor ?? 1),
      'Head is older than the pin.',
    );
    if (pin && h.headVersion === pin.head.headVersion)
      invariant(sameHead, 'SECRETS_FORK', 'Different head at the pinned version.');
    // 4.13 step 7 (GB-08 a): after a proposer or re-pin code the holder's head is the floor, like a pinned head.
    if (code?.headFloor) {
      rollback(h.headVersion >= code.headFloor.version, 'Head is older than the code-confirmed floor.');
      if (h.headVersion === code.headFloor.version)
        invariant(
          sameId(headHash, code.headFloor.hash),
          'SECRETS_FORK',
          'Different head at the code-confirmed floor version.',
        );
    }
    if (adjacent)
      invariant(sameId(h.prevHeadHash, pinnedHash!), 'SECRETS_FORK', 'Head does not extend the pinned head.');
    invariant(
      Number.isSafeInteger(h.setFlags) &&
        h.setFlags >= 0 &&
        h.setFlags <= 1 &&
        (r.setKind === 2 || (h.setFlags === 0 && h.proposers.length === 0)) &&
        h.names.length <= 400 &&
        h.names.filter(n => n.kind !== 3).length <= 200 &&
        new Set(h.names.map(n => n.name)).size === h.names.length,
      'SECRETS_FORMAT_REFUSED',
      'Head fields exceed format bounds.',
    );
    rollback(h.versionFloor >= (pin?.head.versionFloor ?? 0), 'Version floor is older than the pin.');
    const missing = pin?.head.names.filter(old => !h.names.some(n => n.name === old.name)) ?? [];
    if (adjacent) {
      rollback(
        missing.every(n => n.kind === 3),
        'Live names must leave a tombstone.',
      );
      rollback(
        h.versionFloor === Math.max(pin!.head.versionFloor, ...missing.map(n => n.valueVersion)),
        'Version floor may rise only by dropped tombstones.',
      );
    }
    for (const old of missing) {
      if (!adjacent)
        rollback(
          old.valueVersion < h.versionFloor || (old.kind === 3 && old.valueVersion === h.versionFloor),
          'A pinned name disappeared above the floor.',
        );
      notices.push(
        `${safeSecretName(old.name)} left the set in a head this device did not see; head signed by ${h.signerId.toString('hex')}.`,
      );
    }
    for (const n of h.names) {
      const safeName = safeSecretName(n.name);
      invariant(
        [1, 2, 3].includes(n.kind) &&
          n.valueVersion >= 1 &&
          n.valueEpoch >= 1 &&
          n.sealEpoch === h.epoch &&
          Number.isSafeInteger(n.flags) &&
          n.flags >= 0 &&
          n.flags <= 7 &&
          (r.setKind === 2 || (n.flags % 2 === 0 && n.allowedChecks.length === 0)) &&
          (n.kind === 3
            ? n.ctHash.length === 0 && n.valueCommit.length === 0
            : n.ctHash.length === 32 && n.valueCommit.length === 32),
        'SECRETS_FORMAT_REFUSED',
        'Name record fields exceed format bounds.',
      );
      const old = pin?.head.names.find(value => value.name === n.name);
      if (old && old.valueVersion === n.valueVersion) {
        refuse(
          old.kind === n.kind &&
            old.valueEpoch === n.valueEpoch &&
            sameId(old.changedBy, n.changedBy) &&
            old.changedAt === n.changedAt &&
            sameId(old.proposalId, n.proposalId) &&
            sameId(old.valueCommit, n.valueCommit) &&
            sameId(old.changeSig, n.changeSig) &&
            (old.sealEpoch !== n.sealEpoch || sameId(old.ctHash, n.ctHash)),
          'Same-version value or author fields changed.',
        );
        if (old.flags !== n.flags || JSON.stringify(old.allowedChecks) !== JSON.stringify(n.allowedChecks))
          notices.push(`${safeName} permissions changed; head signed by ${h.signerId.toString('hex')}.`);
      } else {
        rollback(!old || n.valueVersion > old.valueVersion, 'Name version is older than the pin.');
        rollback(n.valueVersion > (pin?.head.versionFloor ?? 0), 'Name version is below the pinned floor.');
        const proposal = n.proposalId.length > 0,
          authorRoster = proposal && r.setKind === 2 ? request.development?.roster : r;
        const author = authorRoster && findEntry(authorRoster, n.changedBy),
          former = authorRoster?.former.find(e => sameId(e.deviceId, n.changedBy));
        const fallback = proposal && r.setKind === 2 && !author && !former;
        const markers = proposal && r.setKind === 2 ? (request.developmentRevoked ?? []) : reply.revoked;
        refuse(
          fallback || !markers.some(id => sameId(id, n.changedBy)),
          'A revoked change signer has no new authority.',
        );
        refuse(
          fallback ||
            ((author?.entryKind === 1 || former) &&
              verifyBytes(changeBytes(h, n), n.changeSig, author?.signPub ?? former!.signPub)),
          'Unknown author or invalid change signature.',
        );
        refuse(proposal || former || writeDevice(author, r.setKind), 'Change author lacks write authority.');
        rollback(
          n.valueEpoch >= (request.machine ? 0 : (pin?.head.epoch ?? 0)) &&
            n.valueEpoch <= h.epoch &&
            (!former || (proposal && r.setKind === 2) || n.valueEpoch <= former.lastEpoch),
          'Change epoch is outside its authenticated history.',
        );
        if (adjacent && !(proposal && r.setKind === 2)) {
          refuse(
            n.valueEpoch === h.epoch &&
              (findEntry(r, n.changedBy)?.entryKind === 1 ||
                (pin && findEntry(pin.roster, n.changedBy)?.entryKind === 1)) &&
              (proposal || sameId(n.changedBy, h.signerId)),
            'Adjacent change does not match its author and epoch.',
          );
        }
        const authorLabel = `${n.changedBy.toString('hex')}${former ? ' (removed since)' : ''}`;
        notices.push(
          fallback
            ? `${safeName}: proposed by a device not in this device's Development roster; not checked against Development; head signed by ${h.signerId.toString('hex')}.`
            : `${safeName}: ${proposal ? 'proposed' : 'changed'} by ${authorLabel}${sameId(n.changedBy, h.signerId) ? '' : adjacent ? `, applied by ${h.signerId.toString('hex')}` : `; head signed by ${h.signerId.toString('hex')}`}.`,
        );
      }
    }
    if (request.recipient) {
      invariant(
        new Set(reply.ciphertexts.map(c => c.name)).size === reply.ciphertexts.length &&
          reply.ciphertexts.every(c => h.names.some(n => n.name === c.name && n.kind !== 3)),
        'SECRETS_VALUE_REFUSED',
        'Ciphertexts must name exactly one live signed record.',
      );
      invariant(
        new Set(reply.wraps.map(w => w.recipientId.toString('hex'))).size === reply.wraps.length &&
          reply.wraps.every(w => findEntry(r, w.recipientId)),
        'SECRETS_WRAP_REFUSED',
        'Wraps must name distinct roster recipients.',
      );
      refuse(
        !reply.revoked.some(id => sameId(id, request.recipient!.id)),
        'Forge marked this device for removal: its sign-in ended elsewhere or its person left. An owner device removes it and re-keys on its next write; then share this device again. After Sign out everywhere, if this is the device at hand, run nforge login and approve it in the browser you signed out from.',
      );
      refuse(findEntry(r, request.recipient.id), 'This recipient is revoked or absent.');
      const wrap = reply.wraps.find(w => sameId(w.recipientId, request.recipient!.id));
      invariant(wrap, 'SECRETS_WRAP_REFUSED', 'This recipient has no set-key wrap.');
      key = unwrapSetKey(wrap, r, request.recipient, h.commit);
      const inbox = inboxKeys(key, r);
      try {
        refuse(equalBytes(inbox.publicKey, h.inboxPub), 'Inbox public key does not match the set key.');
      } finally {
        inbox.privateKey.fill(0);
      }
      for (const n of repair ? [] : h.names) {
        if (n.kind === 3) continue;
        const ciphertext = reply.ciphertexts.find(c => c.name === n.name);
        invariant(ciphertext, 'SECRETS_VALUE_REFUSED', 'A signed ciphertext is missing.');
        const opened = openValue(
          key,
          {
            projectId: r.projectId,
            setId: r.setId,
            epoch: r.epoch,
            name: n.name,
            kind: n.kind,
            valueVersion: n.valueVersion,
            valueEpoch: n.valueEpoch,
            sealEpoch: n.sealEpoch,
          },
          ciphertext.stored,
          n,
        );
        opened.r.fill(0);
        const classification = secretNameKind(n.name);
        if (classification === 'denied' || classification === 'invalid') {
          opened.value.fill(0);
          notices.push(`${safeSecretName(n.name)}: name is not accepted; omitted.`);
          continue;
        }
        secrets.push({ name: n.name, kind: n.kind === 1 ? 'env' : 'file', value: opened.value });
      }
    }
    return {
      pin: {
        v: 1,
        genesisHash,
        roster: r,
        head: h,
        rosterHashes: hashes.slice(-64),
        holder: !!request.recipient,
        confirmed: base === 'none' && request.recipient ? 'holder' : base,
      } as SecretPin,
      secrets,
      notices,
      key,
    };
  } catch (error) {
    key?.fill(0);
    for (const secret of secrets) secret.value.fill(0);
    if (error instanceof ForgeError) throw error;
    throw new ForgeError('SECRETS_FORMAT_REFUSED', 'Secret reply is malformed.');
  }
}
