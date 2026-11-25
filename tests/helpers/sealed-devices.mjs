// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// More CLI devices on the synthetic hosted project of sealed-hosted.mjs: each its own account, key store and pins,
// against the same real sealed Convex module.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clone, server } from './sealed-hosted.mjs';
import { forgeSecretId } from '../../dist/sealed-format.js';
import { deviceKeys } from '../../dist/sealed-keys.js';
import { FileKeyStore } from '../../dist/sealed-local.js';
import { SecretPins } from '../../dist/sealed-pins.js';
import { SealedClient } from '../../dist/sealed-client.js';

/** A second CLI device on the same synthetic hosted project, signed in as `account`. */
export function device(
  h,
  t,
  account,
  { member = true, terminal = false, agent = false, keys, deviceName = '' } = {},
) {
  const credentialId = `${account}-device`;
  if (!h.s.tables.cliCredentials.has(`${credentialId}-row`))
    h.s.tables.cliCredentials.set(`${credentialId}-row`, {
      ...clone(h.s.tables.cliCredentials.get('device-row')),
      _id: `${credentialId}-row`,
      owner: account,
      credentialId,
      // Its own sealed links only (Gate B2 M3): the owner row's links name the owner's device.
      sealed: undefined,
    });
  if (member && account !== h.account)
    h.s.tables.projectContributors.set(`pc-${account}`, {
      _id: `pc-${account}`,
      _creationTime: 1,
      projectId: h.project,
      contributor: account,
    });
  const directory = mkdtempSync(join(tmpdir(), 'forge-sealed-join-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  keys ??= deviceKeys(forgeSecretId('account', account));
  const store = new FileKeyStore(join(directory, 'device.bin'));
  store.save({ ...keys, pinCounter: 0 });
  const as = async run => {
    const saved = { ...h.identity };
    Object.assign(h.identity, { subject: account, forgeCredential: credentialId });
    try {
      return await run();
    } finally {
      Object.assign(h.identity, saved);
    }
  };
  const transport = {
    read: input => as(() => server.read._handler(h.s.ctx, { projectId: h.project, ...input })),
    write: input =>
      as(() => h.s.transaction(() => server.write._handler(h.s.ctx, { projectId: h.project, ...input }))),
    join: input =>
      as(() => h.s.transaction(() => server.join._handler(h.s.ctx, { projectId: h.project, ...input }))),
    link: input =>
      as(() => h.s.transaction(() => server.link._handler(h.s.ctx, { projectId: h.project, ...input }))),
    propose: input =>
      as(() => h.s.transaction(() => server.propose._handler(h.s.ctx, { projectId: h.project, ...input }))),
    proposals: input => as(() => server.proposals._handler(h.s.ctx, { projectId: h.project, ...input })),
    reject: input =>
      as(() => h.s.transaction(() => server.reject._handler(h.s.ctx, { projectId: h.project, ...input }))),
  };
  const notices = [];
  const make = (options = {}) =>
    new SealedClient(
      h.project,
      account,
      store.load(),
      new SecretPins(directory, store),
      transport,
      options.agent ?? agent,
      line => notices.push(line),
      options.terminal ?? terminal,
      options.deviceName ?? deviceName,
    );
  return { client: make(), make, notices, keys, transport, directory, store, as };
}
/** The harness owner device, with a join-capable transport and its notices kept. */
export function owner(h, options = {}) {
  const notices = [];
  const transport = {
    ...h.transport,
    join: input => h.s.transaction(() => server.join._handler(h.s.ctx, { projectId: h.project, ...input })),
    link: input => h.s.transaction(() => server.link._handler(h.s.ctx, { projectId: h.project, ...input })),
  };
  const make = (more = {}) =>
    new SealedClient(
      h.project,
      h.account,
      h.pins.store.load(),
      h.pins,
      transport,
      more.agent ?? options.agent ?? false,
      line => notices.push(line),
      more.terminal ?? options.terminal ?? false,
      more.deviceName ?? options.deviceName ?? '',
    );
  return { client: make(), make, notices, transport };
}
