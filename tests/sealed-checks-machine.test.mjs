// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Slice 5 (Item 41a0df87): Checks held by owner devices and CI machine keys; `nforge run --set checks` on any CI.
// Generated test material only: every value below is synthetic.
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { clone, setup } from './helpers/sealed-hosted.mjs';
import { addMachine, checksClient } from '../dist/sealed-checks.js';
import { decodeMachineBundle, encodeMachineBundle, machineKeys } from '../dist/sealed-machine.js';
import { machineRunFor, sealedRunSecrets } from '../dist/sealed-run.js';
import { defaultForgeSite } from '../dist/forge-site.js';
import { runWithSecrets } from '../dist/secret-run.js';
import { framedHash } from '../dist/sealed-format.js';
import { rosterBytes } from '../dist/sealed-records.js';
import { decodeSealedWire } from '../dist/sealed-wire.js';

const machines = await import(moduleUrl('../convex/sealedMachines.ts'));
// A Convex refusal carries its structured code in data (a JSON string or an object).
const code = error =>
  error.code ?? (typeof error.data === 'string' ? JSON.parse(error.data).code : error.data?.code);
const synthetic = label => Buffer.from(`synthetic-${label}-${randomBytes(6).toString('hex')}`);
const sink = () => {
  const chunks = [];
  return {
    stream: new Writable({
      write(chunk, _encoding, done) {
        chunks.push(Buffer.from(chunk));
        done();
      },
    }),
    text: () => Buffer.concat(chunks).toString(),
  };
};
/** An owner with Development and a Checks set of three names, and one CI machine key. */
async function project(t) {
  const h = setup(t);
  await h.client.write('DEV_ONLY', synthetic('dev'));
  const checks = await checksClient(h.client);
  const values = { API_TOKEN: synthetic('api'), DB_URL: synthetic('db'), OTHER: synthetic('other') };
  for (const [name, value] of Object.entries(values)) await checks.write(name, Buffer.from(value));
  const added = await addMachine(checks, 'ci');
  const reads = [];
  const transport = {
    read: async input => {
      reads.push(clone(input));
      return machines.read._handler(h.s.ctx, { projectId: h.project, ...input });
    },
  };
  const tree = mkdtempSync(join(tmpdir(), 'forge-ci-checkout-'));
  t.after(() => rmSync(tree, { recursive: true, force: true }));
  writeFileSync(join(tree, '.env.example'), 'API_TOKEN\nDB_URL\nOTHER\nLISTED_NO_VALUE\n');
  const tempRoot = mkdtempSync(join(tmpdir(), 'forge-ci-temp-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  return { ...h, checks, values, bundle: added.bundle, transport, reads, tree, tempRoot };
}
const machineProvider =
  (p, transport = p.transport) =>
  async input =>
    machineRunFor({ bundle: input.source.FORGE_SECRETS_KEY, forgeProjectId: p.project, transport });
// The child reports which delivered names it sees and whether each value is the one the owner set, and prints one
// value so the test can see it masked. Nothing here prints a value outside the masked stream.
const child = values => [
  process.execPath,
  '-e',
  `const e=process.env,x=${JSON.stringify(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.toString()])))};` +
    `console.log(JSON.stringify({seen:Object.keys(e).filter(k=>/^(API_TOKEN|DB_URL|OTHER|FORGE_.*)$/.test(k)).sort(),` +
    `same:Object.keys(x).filter(k=>e[k]===x[k]).sort()}));console.log('token '+(e.API_TOKEN||''));`,
];
// The two CI shapes the contract covers (BYOCI): the step environment each provider gives, plus the one key.
const adapters = {
  'github-actions': { CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_WORKFLOW: 'test', RUNNER_OS: 'Linux' },
  'gitlab-ci': { CI: 'true', GITLAB_CI: 'true', CI_PIPELINE_SOURCE: 'push', CI_SERVER_NAME: 'GitLab' },
};

test('a mirror check finds the built-in site using only its project ID and machine key', async t => {
  const p = await project(t);
  const fetch = globalThis.fetch;
  const backend = 'https://example.convex.cloud';
  const requests = [];
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    requests.push(url.origin + url.pathname);
    if (url.origin === defaultForgeSite) {
      assert.equal(new Headers(options.headers).has('authorization'), false);
      assert.equal(options.body, undefined);
      return Response.json({ deployment: backend });
    }
    assert.equal(url.origin, backend);
    const request = JSON.parse(options.body);
    assert.equal(request.path, 'sealedMachines:read');
    assert.equal(request.args[0].projectId, p.project);
    return Response.json({ status: 'success', value: null, logLines: [] });
  };
  t.after(() => {
    globalThis.fetch = fetch;
  });
  await assert.rejects(
    sealedRunSecrets({
      root: p.tree,
      set: 'checks',
      source: { FORGE_SECRETS_KEY: p.bundle, FORGE_PROJECT_ID: p.project },
    }),
    { code: 'SECRETS_NOT_SET_UP' },
  );
  assert.deepEqual(requests, [`${defaultForgeSite}/_forge/cli.json`, `${backend}/api/query`]);
});

test('slice 5 BYOCI contract: a check receives exactly its declared names on any CI with one machine key', async t => {
  const p = await project(t);
  for (const [adapter, env] of Object.entries(adapters)) {
    const out = sink(),
      err = sink();
    const code = await runWithSecrets(
      { root: p.tree, set: 'checks', only: ['API_TOKEN', 'DB_URL'], command: child(p.values) },
      machineProvider(p),
      {
        source: { ...env, PATH: process.env.PATH, FORGE_SECRETS_KEY: p.bundle, FORGE_PROJECT_ID: p.project },
        stdout: out.stream,
        stderr: err.stream,
        terminal: false,
        tempRoot: p.tempRoot,
      },
    );
    assert.equal(code, 0, adapter);
    const [summary, printed] = out.text().trim().split('\n');
    // Exactly the declared names, each with the owner's value; never the key, the project id or an undeclared name.
    assert.deepEqual(
      JSON.parse(summary),
      { seen: ['API_TOKEN', 'DB_URL'], same: ['API_TOKEN', 'DB_URL'] },
      adapter,
    );
    // Piped CI output is masked by name.
    assert.equal(printed, 'token [secret:API_TOKEN]', adapter);
    assert.doesNotMatch(out.text() + err.text(), new RegExp(p.values.API_TOKEN.toString()), adapter);
  }
  // Per check: one machine read (project row, set row, history row), no write.
  assert.equal(p.reads.length, 2);
});

test('F1 a machine run masks in a terminal too (a PTY CI runner), and refuses --show', async t => {
  const p = await project(t);
  const out = sink();
  const code = await runWithSecrets(
    { root: p.tree, set: 'checks', only: ['API_TOKEN'], command: child(p.values) },
    machineProvider(p),
    {
      source: { PATH: process.env.PATH, FORGE_SECRETS_KEY: p.bundle },
      stdout: out.stream,
      stderr: sink().stream,
      terminal: true,
      tempRoot: p.tempRoot,
    },
  );
  assert.equal(code, 0);
  assert.equal(out.text().trim().split('\n')[1], 'token [secret:API_TOKEN]');
  assert.doesNotMatch(out.text(), new RegExp(p.values.API_TOKEN.toString()));
  let asked = 0;
  const counting = async input => {
    asked++;
    return machineProvider(p)(input);
  };
  await assert.rejects(
    runWithSecrets(
      { root: p.tree, set: 'checks', only: ['API_TOKEN'], show: true, command: child(p.values) },
      counting,
      {
        source: { PATH: process.env.PATH, FORGE_SECRETS_KEY: p.bundle },
        stdout: sink().stream,
        stderr: sink().stream,
        terminal: true,
        tempRoot: p.tempRoot,
      },
    ),
    { code: 'PERSON_REQUIRED', message: /Checks output is always masked/ },
  );
  // A provider that reports a machine run is refused --show on any set.
  await assert.rejects(
    runWithSecrets(
      { root: p.tree, set: 'development', show: true, command: child(p.values) },
      async () => ({ secrets: [], machine: true }),
      { source: { PATH: process.env.PATH }, stdout: sink().stream, stderr: sink().stream, terminal: true },
    ),
    { code: 'PERSON_REQUIRED', message: /machine run/ },
  );
  assert.equal(asked, 0);
});

test('slice 5: a missing declared name fails setup by name before the command runs', async t => {
  const p = await project(t);
  const marker = join(p.tree, 'ran');
  await assert.rejects(
    runWithSecrets(
      {
        root: p.tree,
        set: 'checks',
        only: ['API_TOKEN', 'LISTED_NO_VALUE', 'NOT_LISTED'],
        command: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`],
      },
      machineProvider(p),
      {
        source: { FORGE_SECRETS_KEY: p.bundle },
        stdout: sink().stream,
        stderr: sink().stream,
        terminal: false,
        tempRoot: p.tempRoot,
      },
    ),
    error =>
      error.code === 'SECRETS_NOT_SET_UP' &&
      /^Check setup failed before the command ran; missing: /.test(error.message) &&
      /LISTED_NO_VALUE \(no value in Checks\)/.test(error.message) &&
      /\nnforge secret set LISTED_NO_VALUE --set checks$/.test(error.message) &&
      /NOT_LISTED \(not listed in \.env\.example\)/.test(error.message) &&
      !/nforge secret set NOT_LISTED/.test(error.message) &&
      !/API_TOKEN/.test(error.message),
  );
  assert.equal(existsSync(marker), false);
});

test('T15 a Checks machine key without --only or a declaration is refused', async t => {
  const p = await project(t);
  await assert.rejects(
    runWithSecrets({ root: p.tree, set: 'checks', command: child(p.values) }, machineProvider(p), {
      source: { FORGE_SECRETS_KEY: p.bundle },
      stdout: sink().stream,
      stderr: sink().stream,
      terminal: false,
      tempRoot: p.tempRoot,
    }),
    { code: 'BAD_ARGUMENT', message: /--only or a supervisor declaration/ },
  );
});

test('slice 5: a machine reads its set only with its own key, for its own project', async t => {
  const p = await project(t);
  const b = decodeMachineBundle(p.bundle);
  const read = token =>
    machines.read._handler(p.s.ctx, {
      projectId: p.project,
      kind: 2,
      machineId: Uint8Array.from(b.machineId).buffer,
      token: Uint8Array.from(token).buffer,
    });
  await assert.rejects(read(randomBytes(32)), error => code(error) === 'AUTH_REQUIRED');
  // Another project's runner holding this key is refused before any read.
  await assert.rejects(
    machineRunFor({ bundle: p.bundle, forgeProjectId: 'another-project', transport: p.transport }),
    { code: 'SECRETS_ROSTER_REFUSED' },
  );
  // A key made for a machine that was never added opens nothing, even with a well-formed bundle.
  const stranger = machineKeys();
  const forged = encodeMachineBundle({
    ...b,
    machineId: stranger.id,
    enc: stranger.enc,
    roster: {
      ...b.roster,
      entries: [
        ...b.roster.entries.filter(e => e.entryKind !== 2),
        { ...b.roster.entries.find(e => e.entryKind === 2), id: stranger.id, encPub: stranger.encPub },
      ],
    },
  });
  await assert.rejects(
    machineRunFor({ bundle: forged, forgeProjectId: p.project, transport: p.transport }),
    error => code(error) === 'AUTH_REQUIRED',
  );
});

test('slice 5: only the write that adds a machine registers its reader, and only on Checks', async t => {
  const p = await project(t);
  // A value write with no roster step cannot register a reader for an existing machine.
  const b = decodeMachineBundle(p.bundle);
  const readers = () => clone([...p.s.tables.sealedMachineReaders.values()]);
  const set = () => clone([...p.s.tables.sealedSecretSets.values()].find(r => r.kind === 2));
  const before = { readers: readers(), set: set() };
  assert.equal(before.readers.length, 1);
  const write = p.checks.transport.write;
  p.checks.transport.write = input =>
    write({
      ...input,
      machineReader: { machineId: Uint8Array.from(b.machineId).buffer, verifier: new ArrayBuffer(32) },
    });
  await assert.rejects(p.checks.write('API_TOKEN', synthetic('api-2')), { code: 'SECRETS_NOT_ALLOWED' });
  p.checks.transport.write = write;
  // Refused before any row changed: the readers and the set row are as they were.
  assert.deepEqual({ readers: readers(), set: set() }, before);
});

test('F4 a machine read checks its token on one small reader row before it reads the set row', async t => {
  const p = await project(t);
  const b = decodeMachineBundle(p.bundle);
  // A CI machine has no Forge sign-in.
  const signedIn = p.s.ctx.auth.getUserIdentity;
  p.s.ctx.auth.getUserIdentity = async () => null;
  t.after(() => (p.s.ctx.auth.getUserIdentity = signedIn));
  const read = (token, machineId = b.machineId) =>
    machines.read._handler(p.s.ctx, {
      projectId: p.project,
      kind: 2,
      machineId: Uint8Array.from(machineId).buffer,
      token: Uint8Array.from(token).buffer,
    });
  for (const [token, machineId] of [
    [randomBytes(32), b.machineId],
    [randomBytes(32), randomBytes(16)],
  ]) {
    const io = { ...p.io };
    await assert.rejects(read(token, machineId), error => code(error) === 'AUTH_REQUIRED');
    // One indexed lookup, of at most one reader row (about 100 bytes); never the project, set or history row.
    assert.equal(p.io.queries - io.queries, 1);
    assert.ok(p.io.readBytes - io.readBytes < 200);
  }
  const io = { ...p.io };
  const opened = await machineRunFor({ bundle: p.bundle, forgeProjectId: p.project, transport: p.transport });
  for (const secret of opened.secrets) secret.value.fill(0);
  // A valid read: the reader row, the project row, the set row and the history row; no writes.
  assert.equal(p.io.queries - io.queries, 4);
  assert.equal(p.io.writes - io.writes, 0);
});

test('T56 a machine refuses a head below its bundle floor, and a bundle past the ring is stale by name', async t => {
  const p = await project(t);
  const row = clone([...p.s.tables.sealedSecretSets.values()].find(r => r.kind === 2));
  // A later value write raises the head; a second machine added after it has that head as its floor.
  await p.checks.write('API_TOKEN', synthetic('api-3'));
  const later = await addMachine(p.checks, 'ci-later');
  const replay = { read: async input => ({ ...(await p.transport.read(input)), payload: row.payload }) };
  // The replayed head names a roster older than the bundle's: a rollback.
  await assert.rejects(
    machineRunFor({ bundle: later.bundle, forgeProjectId: p.project, transport: replay }),
    { code: 'SECRETS_ROLLBACK' },
  );
  // Past the retained ring: the history no longer reaches the bundle's roster.
  const trimmed = {
    read: async input => {
      const wire = await p.transport.read(input);
      return { ...wire, history: { ...wire.history, transitions: [] } };
    },
  };
  await assert.rejects(machineRunFor({ bundle: p.bundle, forgeProjectId: p.project, transport: trimmed }), {
    code: 'SECRETS_PIN_TOO_OLD',
    message: /machine key was made before the Checks history/,
  });
});

test('F5 a machine add with an unknown outcome reconciles on retry and never adds a second machine', async t => {
  const p = await project(t);
  const readers = () => [...p.s.tables.sealedMachineReaders.values()].length;
  const entries = async () => {
    const state = await p.checks.read();
    state.key?.fill(0);
    for (const secret of state.secrets) secret.value.fill(0);
    return state.pin.roster.entries.filter(e => e.entryKind === 2).length;
  };
  assert.equal(readers(), 1);
  const write = p.checks.transport.write;
  for (const reached of [true, false]) {
    // The request reaches the server (or not), and the answer is lost.
    p.checks.transport.write = async input => {
      if (reached) await write(input);
      throw new Error('synthetic connection reset');
    };
    let operationId;
    await assert.rejects(addMachine(p.checks, 'ci-2'), error => {
      operationId = error.recovery?.operationId;
      return (
        error.code === 'SECRETS_WRITE_UNKNOWN' && error.message.includes(`--operation-id ${operationId}`)
      );
    });
    assert.match(operationId, /^[0-9a-f-]{36}$/);
    p.checks.transport.write = write;
    const before = readers();
    const first = await addMachine(p.checks, 'ci-2', { operationId });
    // Exactly one machine for the operation, whichever way the first send went.
    assert.equal(readers(), before + (reached ? 0 : 1));
    assert.equal(first.operationId, operationId);
    // Repeating a finished operation shows the same key and adds nothing.
    const again = await addMachine(p.checks, 'ci-2', { operationId });
    assert.equal(again.machineId, first.machineId);
    assert.equal(decodeMachineBundle(again.bundle).enc.equals(decodeMachineBundle(first.bundle).enc), true);
    assert.equal(readers(), before + (reached ? 0 : 1));
    const opened = await machineRunFor({
      bundle: again.bundle,
      forgeProjectId: p.project,
      transport: p.transport,
    });
    for (const secret of opened.secrets) secret.value.fill(0);
  }
  assert.equal(await entries(), 3);
  assert.equal(readers(), 3);
});

test('F7 the head floor on its own: a genuine head on the bundle roster but below its floor is a rollback', async t => {
  const p = await project(t);
  // Two value writes after the machine was added: heads move on, the roster does not.
  await p.checks.write('API_TOKEN', synthetic('api-4'));
  const middle = clone([...p.s.tables.sealedSecretSets.values()].find(r => r.kind === 2));
  await p.checks.write('API_TOKEN', synthetic('api-5'));
  const b = decodeMachineBundle(p.bundle);
  const top = await p.checks.read();
  assert.equal(top.pin.roster.rosterVersion, b.roster.rosterVersion);
  // The bundle a machine added at the newest head would hold: same roster, floor at that head.
  const raised = encodeMachineBundle({ ...b, headFloor: top.pin.head.headVersion });
  top.key?.fill(0);
  const replay = { read: async input => ({ ...(await p.transport.read(input)), payload: middle.payload }) };
  await assert.rejects(machineRunFor({ bundle: raised, forgeProjectId: p.project, transport: replay }), {
    code: 'SECRETS_ROLLBACK',
  });
  // The same replay is a genuine head at or above the original floor: the residual a new machine key closes.
  const opened = await machineRunFor({ bundle: p.bundle, forgeProjectId: p.project, transport: replay });
  for (const secret of opened.secrets) secret.value.fill(0);
});

test('slice 5: Development names the Checks set, and the machine bundle round-trips strictly', async t => {
  const p = await project(t);
  const dev = await p.client.read();
  const b = decodeMachineBundle(p.bundle);
  assert.ok(dev.pin.roster.checksPointer.checksSetId.equals(b.setId));
  const genesis = decodeSealedWire(
    new Uint8Array([...p.s.tables.sealedSecretHistory.values()].find(r => r.kind === 2).genesis),
  );
  assert.ok(dev.pin.roster.checksPointer.checksGenesisHash.equals(framedHash(rosterBytes(genesis))));
  assert.equal(encodeMachineBundle(b), p.bundle);
  // A changed private key no longer matches the machine its roster names (offset of the enc field in the frame).
  const bytes = Buffer.from(p.bundle.slice(5), 'base64url');
  bytes[105] ^= 0x10; // a bit X25519 clamping keeps
  assert.throws(() => decodeMachineBundle(`fsk1_${bytes.toString('base64url')}`), {
    code: 'SECRETS_FORMAT_REFUSED',
  });
  // A roster that disagrees with its bundle (its set-kind octet, at its fixed offset) is refused.
  const roster = Buffer.from(p.bundle.slice(5), 'base64url');
  assert.equal(roster[217], 2);
  roster[217] = 1;
  assert.throws(() => decodeMachineBundle(`fsk1_${roster.toString('base64url')}`), {
    code: 'SECRETS_FORMAT_REFUSED',
  });
  assert.throws(() => decodeMachineBundle(`fsk1_${Buffer.from('junk').toString('base64url')}`), {
    code: 'SECRETS_FORMAT_REFUSED',
  });
  for (const s of [dev.key, ...dev.secrets.map(x => x.value)]) s?.fill(0);
});

test('slice 5: an agent never sets a Checks value or adds a machine', async t => {
  const p = await project(t);
  const agentDev = Object.assign(Object.create(Object.getPrototypeOf(p.client)), p.client, { agent: true });
  const checks = await checksClient(agentDev);
  await assert.rejects(checks.write('API_TOKEN', synthetic('agent')), { code: 'PERSON_REQUIRED' });
  await assert.rejects(addMachine(checks, 'agent-ci'), { code: 'PERSON_REQUIRED' });
});

test('machine add prints the Checks setup command for declared names, even when Development has the value', async t => {
  const { checksMachineSetupHint } = await import('../dist/sealed-cli.js');
  const h = setup(t);
  await h.client.write('API_TOKEN', synthetic('dev'));
  const checks = await checksClient(h.client);
  const tree = mkdtempSync(join(tmpdir(), 'forge-checks-example-'));
  t.after(() => rmSync(tree, { recursive: true, force: true }));
  writeFileSync(join(tree, '.env.example'), 'API_TOKEN=synthetic-placeholder\n');
  const operationId = '1747867e-4916-4eb3-ac9f-5716ed3ec17e';
  const added = await addMachine(checks, 'ci', { operationId });
  assert.match(
    checksMachineSetupHint(tree, added.valueNames),
    /^No value in Checks[^\n]*\nnforge secret set API_TOKEN --set checks\n$/,
  );
  await checks.write('API_TOKEN', synthetic('checks'));
  const replay = await addMachine(checks, 'ci', { operationId });
  assert.equal(replay.machineId, added.machineId);
  assert.equal(checksMachineSetupHint(tree, replay.valueNames), '');
});
