// SPDX-License-Identifier: Apache-2.0
// Owner rule: a person or machine shown to agents or users is a Forge handle or public GitHub login,
// never a name, email or machine name. No default label may derive from the hostname, and no code
// stores a provider display name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
import { neutralDeviceName, neutralRunnerName, NEUTRAL_MACHINE } from '../dist/neutral-names.js';
import { localAgentSetup } from '../dist/agent-setup.js';

const actors = await import(moduleUrl('../convex/projectActorNames.ts'));
const credentials = await import(moduleUrl('../convex/deviceCredentials.ts'));

function* sources(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '_generated') yield* sources(path);
    } else if (/\.(ts|tsx|mjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) yield path;
  }
}
const root = new URL('../', import.meta.url).pathname;

test('hostname() only identifies a process or hashes a runner id; it never becomes a label', () => {
  // Process-liveness records compare or store `host`; the runner id hashes it. Anything else
  // (a default name, a template, a returned field) is a hostname leak.
  const allowed = [
    /\bhost\s*(===|!==)\s*hostname\(\)/,
    /\bhost\s*:\s*hostname\(\)/,
    /\.update\(JSON\.stringify\(\[[^\]]*hostname\(\)\]\)\)/,
  ];
  const found = [];
  for (const base of ['src', 'convex', 'web/src', 'scripts'])
    for (const file of sources(join(root, base)))
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (
            /\bhostname\(\)/.test(line) &&
            !/^\s*(\/\/|\*)/.test(line) &&
            !allowed.some(rule => rule.test(line))
          )
            found.push(`${file.slice(root.length)}:${index + 1}: ${line.trim()}`);
        });
  assert.deepEqual(found, []);
  for (const file of ['src/auth-cli.ts', 'src/agent-setup.ts'])
    assert.doesNotMatch(readFileSync(join(root, file), 'utf8'), /hostname\s*[,}]|\bhostname\(\)/, file);
});

test('default labels are neutral and never contain the hostname', async () => {
  const { hostname } = await import('node:os');
  const host = hostname();
  for (let i = 0; i < 50; i++) assert.match(neutralDeviceName(), /^device-[0-9a-f]{4}$/);
  const runner = neutralRunnerName('https://deployment.example', 'project', '/root');
  assert.match(runner, /^runner-[0-9a-f]{4}$/);
  assert.equal(runner, neutralRunnerName('https://deployment.example', 'project', '/root'), 'stable');
  assert.equal(
    runner,
    `runner-${createHash('sha256')
      .update(JSON.stringify(['https://deployment.example', 'project', '/root']))
      .digest('hex')
      .slice(0, 4)}`,
    'derived from deployment, project and root only',
  );
  const saved = process.env.FORGE_MACHINE;
  delete process.env.FORGE_MACHINE;
  try {
    assert.equal(localAgentSetup(root).machine, NEUTRAL_MACHINE);
    process.env.FORGE_MACHINE = 'chosen-label';
    assert.equal(localAgentSetup(root).machine, 'chosen-label');
  } finally {
    if (saved === undefined) delete process.env.FORGE_MACHINE;
    else process.env.FORGE_MACHINE = saved;
  }
  for (const label of [neutralDeviceName(), runner, NEUTRAL_MACHINE])
    assert(!host || host.length < 3 || !label.toLowerCase().includes(host.toLowerCase()), label);
});

test('the purge deletes name-only rows, strips names from membership rows and keeps provenance', async () => {
  // Convex cursors are key positions, so deleting already-visited rows cannot skip later ones.
  const s = state([], { keysetPaging: true });
  const add = fields => s.ctx.db.insert('projectActorNames', { projectId: 'project', ...fields });
  for (let i = 0; i < 230; i++) await add({ actor: `a${i}`, displayName: `Person ${i}` });
  await add({ actor: 'gone', displayName: 'Gone Person', wasMember: true });
  await add({ actor: 'plain-former', displayName: '', wasMember: true });
  await add({ actor: 'clean-former', wasMember: true });
  let cursor = null,
    calls = 0,
    deleted = 0,
    cleared = 0,
    done = false;
  while (!done) {
    const result = await actors.purgeDisplayNames._handler(s.ctx, { cursor });
    calls++;
    deleted += result.deleted;
    cleared += result.cleared;
    ({ cursor, isDone: done } = result);
    assert(calls < 10);
  }
  assert.deepEqual({ deleted, cleared }, { deleted: 230, cleared: 2 });
  assert.equal(calls, 3, '233 rows at 100 per call');
  assert.deepEqual(
    [...s.tables.projectActorNames.values()].map(r => [
      r.actor,
      'displayName' in r && r.displayName !== undefined,
    ]),
    [
      ['gone', false],
      ['plain-former', false],
      ['clean-former', false],
    ],
  );
  s.tables.hostedProjects.set('project', { _id: 'project', owner: 'owner' });
  assert.equal((await actors.withActorName(s.ctx, 'project', { actor: 'gone' })).actorFormerMember, true);
  // A second pass has nothing to do.
  const again = await actors.purgeDisplayNames._handler(s.ctx, { cursor: null });
  assert.deepEqual([again.deleted, again.cleared], [0, 0]);
});

test('retaining membership stores no name, and the removed writer is gone', async () => {
  const s = state([]);
  await actors.retainMembership(s.ctx, 'project', 'person');
  const [stored] = [...s.tables.projectActorNames.values()];
  assert.equal(stored.wasMember, true);
  assert(!('displayName' in stored));
  assert.equal(actors.remember, undefined);
  assert.doesNotMatch(readFileSync(join(root, 'convex/projectActorNames.ts'), 'utf8'), /rememberActor/);
});

test('a device renames only itself or an owned credential, with a bounded trimmed name', async () => {
  const s = state([]);
  s.tables.cliCredentials = new Map();
  const id = await s.ctx.db.insert('cliCredentials', {
    owner: 'owner',
    name: 'nforge on legacy',
    scope: 'cli',
    credentialId: 'cred',
    tokenHash: 'hash',
    issuedAt: 1,
    expiresAt: 2,
    revoked: false,
  });
  const rename = (name, credentialId = 'cred') =>
    credentials.rename._handler(s.ctx, { credentialId, name, operationId: 'op' });
  s.caller('owner');
  await rename('  Desk  ');
  assert.equal(s.tables.cliCredentials.get(id).name, 'Desk');
  await rename('Desk');
  await assert.rejects(rename('   '), /1 to 80/);
  await assert.rejects(rename('x'.repeat(81)), /1 to 80/);
  s.caller('stranger');
  await assert.rejects(rename('Hijack'), /own device/);
  assert.equal(s.tables.cliCredentials.get(id).name, 'Desk');
});
