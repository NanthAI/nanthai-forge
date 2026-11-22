// SPDX-License-Identifier: Apache-2.0
// Design 5.1 journeys on a device: the joining device posts its own request and waits, then pins on first use
// (Gate B1 M2); a holder device wraps for waiting devices on its next run, in one signed write. No polling: a
// joiner and a holder each act only when their own command runs.
import { randomUUID } from 'node:crypto';
import { ForgeError, invariant } from './errors.js';
import { equalBytes, forgeSecretId, framedHash } from './sealed-format.js';
import {
  automaticShareReply,
  joinRequestBytes,
  ownDevicesNotice,
  planAutomaticShares,
} from './sealed-auto.js';
import { requireConfirmedBase, type JourneyAnchor } from './sealed-anchors.js';
import { AUTOMATIC_SHARES_PER_DAY, deviceFingerprint } from './sealed-join.js';
import { headBytes } from './sealed-records.js';
import { findEntry, ownerDevice, sameId } from './sealed-roster.js';
import {
  clearJoin,
  ownJoin,
  pauseSharing,
  recordJoin,
  reserveShares,
  settleShares,
  shareNotices,
  sharesLeftToday,
  sharingPaused,
} from './sealed-share-log.js';
import { sealedRefusal, sealedWrite, sealedWriteArgs, type SealedReadWire } from './sealed-transport.js';
import { verifySealedReply, type SealedReply, type SecretPin } from './sealed-verify.js';
import type { SealedClient } from './sealed-client.js';

type Verified = ReturnType<typeof verifySealedReply>;
const discard = (result: Verified | undefined) => {
  result?.key?.fill(0);
  for (const secret of result?.secrets ?? []) secret.value.fill(0);
};

/** With no pin: the anchor for this device's first contact, or this device's own join request and a wait. */
export async function firstContactAnchor(
  client: SealedClient,
  reply: SealedReply,
  wire: SealedReadWire,
): Promise<JourneyAnchor | undefined> {
  const { keys } = client;
  if (reply.genesis.entries[0] && sameId(reply.genesis.entries[0].id, keys.id)) return undefined;
  const requestedAt = await ownJoin(client.pins, client.project);
  const accountId = forgeSecretId('account', client.account);
  if (findEntry(reply.roster, keys.id))
    // Listed without this device's own request: the creator-only anchor refuses it (fail closed).
    return requestedAt
      ? {
          kind: 'automatic-join',
          value: { id: keys.id, accountId, signPub: keys.signPub, encPub: keys.encPub, requestedAt },
        }
      : undefined;
  // The served roster is untrusted here; it only decides whether asking can help.
  const fp = deviceFingerprint(keys.id);
  invariant(
    reply.roster.sharingMode === 1,
    'SECRETS_NOT_ALLOWED',
    `Development uses Confirm: ask a holder to add this device with a code. This device's fingerprint: ${fp}.`,
  );
  invariant(
    !reply.roster.entries.some(e => sameId(e.accountId, accountId)),
    'SECRETS_NOT_ALLOWED',
    `Your account already has a device in Development: add this one from that device with a code. This device's fingerprint: ${fp}.`,
  );
  const request = joinRequestBytes(client.project, client.account, keys);
  // Recorded before posting, so the anchor only ever rests on this device's own request.
  await recordJoin(client.pins, client.project, Date.now());
  if (!wire.joinRequests?.some(r => equalBytes(new Uint8Array(r), request))) {
    invariant(client.transport.join, 'SECRETS_NOT_ALLOWED', 'This storage cannot take a join request.');
    try {
      await client.transport.join({ kind: 1, request: Uint8Array.from(request).buffer });
    } catch (error) {
      throw sealedRefusal(error) ?? error;
    }
  }
  throw new ForgeError(
    'SECRETS_WAITING',
    `Waiting for a Development holder to share it with this device (fingerprint ${fp}). A holder device does it on its own next run; run this command again after that, not in a loop. The holder's notice shows the same fingerprint.`,
  );
}

/** After a verified read: first-run and own-account notices, then this holder's automatic shares. */
export async function afterVerified(
  client: SealedClient,
  reply: SealedReply,
  result: Verified,
  previous: SecretPin | null,
  anchor: JourneyAnchor | undefined,
  wire: SealedReadWire | null,
) {
  const lines: string[] = [];
  if (anchor?.kind === 'automatic-join') {
    await clearJoin(client.pins, client.project);
    lines.push(
      `This device joined Development automatically, trusting Forge on first use. Its fingerprint: ${deviceFingerprint(client.keys.id)}; the holder that shared it was told the same.`,
    );
  }
  const own = ownDevicesNotice(previous?.roster ?? null, result.pin.roster, client.keys.id);
  if (own) lines.push(own);
  let roster: SecretPin['roster'] | null = result.pin.roster;
  if (wire?.joinRequests?.length && result.key) {
    const shared = await shareWaiting(client, reply, result, wire);
    lines.push(...shared.lines);
    roster = shared.roster;
  }
  if (roster) await settleShares(client.pins, client.project, roster, Date.now());
  lines.push(...(await shareNotices(client.pins, client.terminal)));
  return lines;
}

async function shareWaiting(
  client: SealedClient,
  reply: SealedReply,
  result: Verified,
  wire: SealedReadWire,
) {
  // Server gate stage 3 (member writes) is not enabled, so today only owner devices write and wrap.
  const unchanged = (lines: string[]) => ({ lines, roster: result.pin.roster });
  if (!ownerDevice(findEntry(result.pin.roster, client.keys.id))) return unchanged([]);
  // GB-08 d4 (a no-op for Development, the only kind planAutomaticShares ever fills).
  requireConfirmedBase(result.pin, 'wrap');
  const now = Date.now();
  // A refusal pauses sharing for a day: no refused mutation on every run.
  if (sharingPaused(client.pins, client.project, now)) return unchanged([]);
  const plan = planAutomaticShares({
    roster: result.pin.roster,
    revoked: reply.revoked,
    requests: wire.joinRequests!.map(r => new Uint8Array(r)),
    self: client.keys.id,
    quota: Math.max(0, sharesLeftToday(client.pins, now)),
  });
  const lines = [...plan.skipped];
  if (!plan.entries.length) return unchanged(lines);
  // Guard 5 is decided under the lock, and recorded before any wrap exists (guard 4).
  const granted = await reserveShares(
    client.pins,
    client.project,
    plan.entries.map(e => e.id),
    now,
  );
  const entries = plan.entries.filter(e => granted.some(id => sameId(id, e.id)));
  if (entries.length < plan.entries.length)
    lines.push(
      `Not shared now: this device made ${AUTOMATIC_SHARES_PER_DAY} automatic shares today (another run took the rest).`,
    );
  if (!entries.length) return unchanged(lines);
  let saved: Verified | undefined;
  try {
    const verified: SealedReply = { ...reply, roster: result.pin.roster, head: result.pin.head };
    const built = automaticShareReply(verified, result.key!, entries, client.keys, now, result.pin);
    discard(verifySealedReply(built, result.pin, client.request()));
    const out = sealedWrite(built, randomUUID(), {
      headHash: framedHash(headBytes(result.pin.head)),
      rosterVersion: result.pin.roster.rosterVersion,
    });
    let receipt: { accepted: boolean };
    try {
      receipt = await client.transport.write({ ...sealedWriteArgs(out), kind: 1 });
    } catch (error) {
      const refused = sealedRefusal(error);
      if (!refused) throw error;
      await pauseSharing(client.pins, client.project, refused.code, Date.now());
      // Settled against the verified roster, the signed share stays recorded as unconfirmed, never dropped.
      return unchanged([
        ...lines,
        `Automatic sharing was refused by Forge (${refused.code}); it pauses on this device for a day.`,
      ]);
    }
    if (!receipt.accepted)
      return unchanged([
        ...lines,
        'Another write changed Development first; automatic sharing retries on the next run.',
      ]);
    saved = await client.pins.verifyAndSave(built, client.request(), Date.now());
    return { lines: [...lines, ...saved.notices], roster: built.roster };
  } catch (error) {
    // An unknown outcome keeps the record as sending; the next verified read settles it to done or unconfirmed.
    const code = error instanceof ForgeError ? error.code : 'SECRETS_WRITE_UNKNOWN';
    return {
      lines: [...lines, `Automatic sharing did not complete (${code}); it retries on the next run.`],
      roster: null,
    };
  } finally {
    discard(saved);
  }
}
