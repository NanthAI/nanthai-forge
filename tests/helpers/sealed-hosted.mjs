// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// A synthetic hosted project with an owner stable device, the sealed Convex module and a counting db.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serialize, deserialize } from 'node:v8';
import { getConvexSize } from 'convex/values';
import { moduleUrl } from '../convex-module.mjs';
import { state, projectRow } from '../hosted-fixture.mjs';
import { fixture } from './sealed-fixture.mjs';
import { FileKeyStore } from '../../dist/sealed-local.js';
import { SecretPins } from '../../dist/sealed-pins.js';
import { SealedClient } from '../../dist/sealed-client.js';

export const server = await import(moduleUrl('../convex/sealedSecrets.ts'));
export const clone = x => deserialize(serialize(x));
export function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-sealed-client-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const s = state(),
    f = fixture(),
    project = f.request.forgeProjectId,
    account = 'fixture-owner',
    credentialId = 'sealed-device';
  s.tables.hostedProjects.set(project, projectRow({ _id: project, owner: account }));
  s.tables.cliCredentials.set('device-row', {
    _id: 'device-row',
    _creationTime: 1,
    owner: account,
    name: 'synthetic',
    scope: 'cli',
    credentialId,
    tokenHash: 'synthetic-hash',
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60000,
    revoked: false,
    deviceKey: 'synthetic-public-key',
    deviceApprovedAt: Date.now(),
    renewal: { operationId: 'sign-in', requestHash: 'synthetic', issuedAt: Date.now() },
    settings: { source: 'write', projects: { kind: 'all' } },
  });
  const identity = { subject: account, forgeCredential: credentialId, forgeSignIn: 'sign-in' };
  s.ctx.auth.getUserIdentity = async () => identity;
  const io = { queries: 0, documents: 0, readBytes: 0, writes: 0 };
  const countRead = value => {
    io.queries++;
    if (value) {
      io.documents++;
      io.readBytes += getConvexSize(value);
    }
    return value;
  };
  const db = s.ctx.db;
  s.ctx.db = new Proxy(db, {
    get(target, key) {
      if (key === 'get') return async id => countRead(await target.get(id));
      if (key === 'query')
        return table => {
          const query = target.query(table);
          const wrapped = new Proxy(query, {
            get(q, method) {
              if (method === 'unique') return async () => countRead(await q.unique());
              const member = q[method];
              return typeof member === 'function'
                ? (...args) => {
                    const next = member.apply(q, args);
                    return next === q ? wrapped : next;
                  }
                : member;
            },
          });
          return wrapped;
        };
      if (['insert', 'replace', 'patch', 'delete'].includes(key))
        return (...args) => {
          io.writes++;
          return target[key](...args);
        };
      const member = Reflect.get(target, key);
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
  const calls = [];
  let writes = Promise.resolve();
  const transport = {
    read: async input => {
      calls.push(clone({ action: 'read', input }));
      return server.read._handler(s.ctx, { projectId: project, ...input });
    },
    write: async input => {
      calls.push(clone({ action: 'write', input }));
      const result = writes.then(() =>
        s.transaction(() => server.write._handler(s.ctx, { projectId: project, ...input })),
      );
      writes = result.catch(() => {});
      return result;
    },
  };
  const store = new FileKeyStore(join(directory, 'device.bin'));
  store.save({ ...f.keys, pinCounter: 0 });
  const keys = store.load(),
    pins = new SecretPins(directory, store),
    client = new SealedClient(project, account, keys, pins, transport, false);
  return { directory, s, f, project, account, identity, calls, transport, client, pins, keys, io };
}
