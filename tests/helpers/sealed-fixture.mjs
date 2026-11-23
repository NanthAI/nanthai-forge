// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { SecretTestServer } from './secret-server.mjs';
import { forgeSecretId, framedHash } from '../../dist/sealed-format.js';
import { deviceKeys, keyCommit, inboxKeys, signBytes, wrapSetKey } from '../../dist/sealed-keys.js';
import { rosterBytes, headBytes, changeBytes, transitionBytes } from '../../dist/sealed-records.js';
import { sealValue, openValue } from '../../dist/sealed-value.js';
import { verifySealedReply } from '../../dist/sealed-verify.js';
export function fixture(seed = 17, project = 'fixture-project', kind = 1) {
  const server = new SecretTestServer(seed),
    random = n => Buffer.from(server.bytes(n)),
    account = forgeSecretId('account', 'fixture-owner'),
    keys = deviceKeys(account, random),
    key = random(32),
    setId = random(16),
    projectId = forgeSecretId('project', project);
  const entry = (d = keys, opts = {}) => ({
    entryKind: 1,
    id: d.id,
    encPub: d.encPub,
    signPub: d.signPub,
    accountId: account,
    accountHandle: 'fixture-owner',
    displayName: 'fixture-device',
    role: 1,
    addedBy: keys.id,
    how: 1,
    addedAtRosterVersion: 1,
    bindSig: d.bindSig,
    ...opts,
  });
  const roster = {
    v: 1,
    projectId,
    setId,
    setKind: kind,
    sharingMode: 2,
    checksPointer: null,
    rosterVersion: 1,
    epoch: 1,
    prevRosterHash: Buffer.alloc(32),
    entries: [entry()],
    former: [],
  };
  const head = {
    v: 1,
    projectId,
    setId,
    setKind: kind,
    headVersion: 1,
    prevHeadHash: Buffer.alloc(32),
    rosterVersion: 1,
    rosterHash: framedHash(rosterBytes(roster)),
    epoch: 1,
    commit: keyCommit(key, roster),
    inboxPub: inboxKeys(key, roster).publicKey,
    versionFloor: 0,
    setFlags: 0,
    proposers: [],
    names: [],
    signerId: keys.id,
    signedAt: 1000,
    signature: Buffer.alloc(64),
  };
  const reply = {
    v: 1,
    genesis: roster,
    roster,
    head,
    transitions: [],
    ciphertexts: [],
    wraps: [],
    revoked: [],
    supersede: null,
    proposals: [],
  };
  const f = {
    server,
    random,
    keys,
    key,
    account,
    entry,
    reply,
    request: {
      forgeProjectId: project,
      setKind: kind,
      firstContact: true,
      // This device made the genesis of either kind. A walk-only Checks anchor opens no wrap (GB-08 d4).
      anchor: { kind: 'own-genesis', deviceId: keys.id },
      recipient: { id: keys.id, enc: keys.enc, kind: 1 },
    },
  };
  f.signHead = (signer = keys) => {
    reply.head.signerId = signer.id;
    reply.head.signature = signBytes(headBytes(reply.head), signer.sign);
    return reply;
  };
  f.wrap = () => {
    reply.wraps = reply.roster.entries.map(e =>
      wrapSetKey(f.key, reply.roster, { id: e.id, encPub: e.encPub, kind: e.entryKind }, random),
    );
    reply.head.commit = keyCommit(f.key, reply.roster);
    reply.head.inboxPub = inboxKeys(f.key, reply.roster).publicKey;
    f.signHead();
  };
  f.pin = () => verifySealedReply(reply, null, f.request).pin;
  f.bump = () => {
    reply.head = {
      ...reply.head,
      headVersion: reply.head.headVersion + 1,
      prevHeadHash: framedHash(headBytes(reply.head)),
      signedAt: reply.head.signedAt + 1,
      names: [...reply.head.names],
    };
    return f;
  };
  f.name = (name = 'API_TOKEN', value = Buffer.from('synthetic-value-0123456789'), options = {}) => {
    const old = reply.head.names.find(n => n.name === name),
      n = {
        name,
        kind: 1,
        valueVersion: old ? old.valueVersion + 1 : reply.head.versionFloor + 1,
        valueEpoch: reply.roster.epoch,
        sealEpoch: reply.roster.epoch,
        ctHash: Buffer.alloc(0),
        valueCommit: Buffer.alloc(0),
        changedBy: keys.id,
        changedAt: reply.head.signedAt,
        proposalId: Buffer.alloc(0),
        flags: 0,
        allowedChecks: [],
        ...options,
      };
    if (n.kind !== 3) {
      const sealed = sealValue(f.key, { ...reply.roster, ...n }, value, { random });
      n.ctHash = sealed.ctHash;
      n.valueCommit = sealed.valueCommit;
      reply.ciphertexts = reply.ciphertexts
        .filter(c => c.name !== name)
        .concat({ name, stored: sealed.stored });
    } else reply.ciphertexts = reply.ciphertexts.filter(c => c.name !== name);
    n.changeSig = signBytes(changeBytes(reply.head, n), options.signer?.sign ?? keys.sign);
    delete n.signer;
    reply.head.names = reply.head.names.filter(v => v.name !== name).concat(n);
    f.signHead();
    return n;
  };
  f.rekey = (delta = { epochBumped: 1 }) => {
    const opened = reply.head.names
      .filter(n => n.kind !== 3)
      .map(n => ({
        n,
        opened: openValue(
          f.key,
          { ...reply.roster, ...n },
          reply.ciphertexts.find(c => c.name === n.name).stored,
          n,
        ),
      }));
    f.bump();
    f.transition(delta);
    f.key = random(32);
    for (const { n, opened: o } of opened) {
      n.sealEpoch = reply.roster.epoch;
      const sealed = sealValue(f.key, { ...reply.roster, ...n }, o.value, { r: o.r, random });
      n.ctHash = sealed.ctHash;
      reply.ciphertexts = reply.ciphertexts
        .filter(c => c.name !== n.name)
        .concat({ name: n.name, stored: sealed.stored });
      o.r.fill(0);
      o.value.fill(0);
    }
    for (const n of reply.head.names) if (n.kind === 3) n.sealEpoch = reply.roster.epoch;
    f.wrap();
    return f;
  };
  f.transition = (delta = {}, signer = keys) => {
    const from = reply.roster,
      d = {
        added: [],
        removed: [],
        roles: [],
        droppedFormer: [],
        newSharingMode: null,
        newChecksPointer: null,
        supersede: null,
        epochBumped: 0,
        ...delta,
      };
    const removed = from.entries.filter(e => d.removed.some(id => id.equals(e.id)));
    const next = {
      ...from,
      rosterVersion: from.rosterVersion + 1,
      epoch: from.epoch + d.epochBumped,
      prevRosterHash: framedHash(rosterBytes(from)),
      entries: [
        ...from.entries
          .filter(e => !removed.includes(e))
          .map(e => ({ ...e, role: d.roles.find(r => r.id.equals(e.id))?.role ?? e.role })),
        ...d.added,
      ],
      former: [
        ...from.former,
        ...removed
          .filter(e => e.entryKind === 1)
          .map(e => ({ deviceId: e.id, signPub: e.signPub, lastEpoch: from.epoch })),
      ].filter(e => !d.droppedFormer.some(id => id.equals(e.deviceId))),
      sharingMode: d.newSharingMode ?? from.sharingMode,
      checksPointer: d.newChecksPointer ?? from.checksPointer,
    };
    const t = {
      fromVersion: from.rosterVersion,
      fromHash: framedHash(rosterBytes(from)),
      toVersion: next.rosterVersion,
      toHash: framedHash(rosterBytes(next)),
      delta: d,
      signerId: signer.id,
    };
    t.signature = signBytes(transitionBytes(from, t), signer.sign);
    reply.transitions.push(t);
    reply.roster = next;
    reply.head = {
      ...reply.head,
      rosterVersion: next.rosterVersion,
      rosterHash: t.toHash,
      epoch: next.epoch,
    };
    f.signHead();
    return t;
  };
  f.wrap();
  if (kind === 2) {
    const dev = fixture(seed, project, 1);
    dev.transition({
      newChecksPointer: { checksSetId: setId, checksGenesisHash: framedHash(rosterBytes(roster)) },
    });
    f.request.development = dev.pin();
    f.dev = dev;
  }
  return f;
}
