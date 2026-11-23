// SPDX-License-Identifier: Apache-2.0
// Drives the 4.13 code journey between a requester and a holder over the synthetic sealed fixture.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeApprover, CodeRequester } from '../../dist/sealed-code.js';
import { FileKeyStore } from '../../dist/sealed-local.js';
import { SecretPins } from '../../dist/sealed-pins.js';
import { framedHash } from '../../dist/sealed-format.js';
import { forgeSecretId } from '../../dist/sealed-format.js';
import { deviceKeys } from '../../dist/sealed-keys.js';
import { headBytes } from '../../dist/sealed-records.js';

export const codeDevice = (keys, accountId, name = 'new-device') => ({
  id: keys.id,
  accountId,
  signPub: keys.signPub,
  encPub: keys.encPub,
  accountHandle: 'fixture-member',
  displayName: name,
  bindSig: keys.bindSig,
});
export function newAccountDevice(f, account = 'joining-member') {
  const accountId = forgeSecretId('account', account);
  return { accountId, keys: deviceKeys(accountId, f.random) };
}
/** Publish what the holder signed: a roster step (with fresh wraps for every recipient) or a head. */
export function publish(f, typed) {
  const a = typed.approval;
  if (a.purpose === 1 || a.purpose === 2) {
    f.bump();
    f.reply.roster = typed.roster;
    f.reply.transitions.push(a.transition);
    Object.assign(f.reply.head, {
      rosterVersion: typed.roster.rosterVersion,
      rosterHash: a.transition.toHash,
      epoch: typed.roster.epoch,
    });
    f.wrap();
  } else if (a.purpose === 3) f.reply.head = a.head;
  return f;
}
/** The approving device's own pin store. Each read() is a fresh read verified and saved in this process: the only
 * pin a holder approves a code on, once (Gate B2 H1). */
export function holder(t, f, { keys = f.keys, request = f.request } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-code-holder-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new FileKeyStore(join(directory, 'device.bin'));
  store.save({ ...keys, pinCounter: 0 });
  const pins = new SecretPins(directory, store);
  return {
    pins,
    directory,
    read: async (reply = f.reply) => {
      const result = await pins.verifyAndSave(reply, request, 1, true);
      result.key?.fill(0);
      for (const secret of result.secrets) secret.value.fill(0);
      return result.pin;
    },
  };
}
export const freshPin = (t, f, options) => holder(t, f, options).read();
/** One full journey; `holderPin` is the approving device's fresh pin of this set (see holder). */
export function runCode(
  f,
  { purpose, view = f.reply.roster, device, holderPin, signer = f.keys, development },
) {
  const requester = new CodeRequester(purpose, view, device);
  const approver = new CodeApprover({
    request: requester.request,
    pin: holderPin,
    signer,
    ...(development ? { development } : {}),
    person: true,
  });
  const typed = approver.type(requester.words.join(' '), 5000);
  publish(f, typed);
  const confirmed = requester.confirm(typed.reply.join(' '), typed.approval);
  return { requester, approver, typed, anchor: confirmed.anchor, confirmed };
}
export const headHash = head => framedHash(headBytes(head));
