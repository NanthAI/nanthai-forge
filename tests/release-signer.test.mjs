// SPDX-License-Identifier: Apache-2.0
// Automated release signer: signed-out signatures verified by the store, the key-proof read, and a
// mirror backlog replay through the workflow's own tip step (docs/operations/cli-update.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moduleUrl } from './convex-module.mjs';
import { forgeStateTrailer, signRelease } from '../scripts/release-sign-ci.mjs';
import { cliReleaseStatement, cliReleaseReadStatement } from '../src/cli-release-statement.ts';
import { CLI_RELEASE_KEYS } from '../src/cli-release-keys.ts';

const store = await import(moduleUrl('../convex/projectReleaseSignatures.ts'));
const project = 'k17testproject0000aaaabbbbccccdd';
/** Matches a ForgeError (direct call) or a reported ConvexError by its code. */
const is = code => error => (assert.equal(error.code ?? error.data?.code, code), true);
const state = n => n.toString(16).padStart(64, '0');

function releaseKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  const id = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  return {
    pem: privateKey.export({ format: 'pem', type: 'pkcs8' }),
    listed: { id, publicKey: raw.toString('base64') },
    sign: text => sign(null, Buffer.from(text), privateKey).toString('base64'),
  };
}
const signed = (key, head, release, projectId = project) => ({
  projectId,
  head,
  keyId: key.listed.id,
  signature: key.sign(cliReleaseStatement(projectId, head, release)),
  release,
});

/** In-memory db: projects, main Channels and signature rows; counts every read. */
function context({ main = state(1), revision = 41 } = {}) {
  const rows = [],
    reads = { get: 0, index: 0 },
    channel = {
      main,
      revision,
    };
  const projects = new Map([
    [
      project,
      {
        _id: project,
        owner: 'owner',
        visibility: 'private',
        name: 'p',
        key: 'p',
        sourceAuthority: { mode: 'server', epoch: 1 },
      },
    ],
    [
      'removed',
      { _id: 'removed', owner: 'owner', visibility: 'private', name: 'r', key: 'r', removal: { at: 1 } },
    ],
  ]);
  const selection = projectId =>
    JSON.stringify({
      schema: 2,
      projectId,
      snapshotId: 's',
      sourceRevision: channel.revision,
      authority: { mode: 'server', epoch: 1 },
      channel: 'main',
      head: channel.main,
      receipt: { id: 'r', kind: 'server', previousHead: null, previousReceiptId: null },
    });
  const db = {
    get: async id => (reads.get++, projects.get(id) ?? null),
    normalizeId: () => null,
    insert: async (table, value) => {
      assert.equal(table, 'projectReleaseSignatures');
      rows.push(value);
      return `row${rows.length}`;
    },
    query: table => ({
      withIndex: (name, range) => {
        const eq = {};
        const q = { eq: (field, value) => ((eq[field] = value), q) };
        range(q);
        const match = () => rows.filter(row => Object.entries(eq).every(([k, v]) => row[k] === v));
        return {
          take: async n => (reads.index++, match().slice(0, n)),
          order: () => ({
            first: async () => (
              reads.index++,
              match()
                .sort((x, y) => (x.release ?? -1) - (y.release ?? -1))
                .at(-1) ?? null
            ),
          }),
          unique: async () => {
            reads.index++;
            assert.equal(table, 'projectHostedChannels');
            return projects.has(eq.projectId) ? { selection: selection(eq.projectId) } : null;
          },
        };
      },
    }),
  };
  return { rows, reads, channel, ctx: { db, auth: { getUserIdentity: async () => null } } };
}
const put = (s, input, keys) => store.putReleaseSignature(s.ctx, input, keys);

test('signed out: a wrong signature costs one refused call, reads nothing and writes nothing', async () => {
  const s = context(),
    key = releaseKey(),
    other = releaseKey(),
    keys = [key.listed];
  const good = signed(key, state(1), 41);
  const refusals = [
    // The production handler with the listed production key id and a forged signature.
    () => store.put._handler(s.ctx, { ...good, keyId: CLI_RELEASE_KEYS[0].id }),
    // Exactly this project, State and release number: any other binding fails.
    () => put(s, { ...good, release: 42 }, keys),
    () => put(s, { ...good, head: state(2) }, keys),
    () => put(s, { ...signed(key, state(1), 41, 'elsewhere'), projectId: project }, keys),
    // An unlisted key, even with a valid signature of its own.
    () => put(s, signed(other, state(1), 41), keys),
    // A v1 signature (no release number) is owner-only.
    () =>
      put(
        s,
        {
          projectId: project,
          head: state(1),
          keyId: key.listed.id,
          signature: key.sign(cliReleaseStatement(project, state(1))),
        },
        keys,
      ),
    // Malformed bytes.
    () => put(s, { ...good, signature: `${'A'.repeat(86)}==` }, keys),
  ];
  for (const refuse of refusals) await assert.rejects(refuse(), is('RELEASE_SIGNATURE_INVALID'));
  assert.deepEqual(s.rows, []);
  assert.deepEqual(s.reads, { get: 0, index: 0 });
});

test('signed out: a good signature is stored without auth, and the number rules and cap still hold', async () => {
  const s = context(),
    keys = Array.from({ length: 5 }, releaseKey),
    listed = keys.map(key => key.listed);
  const first = await put(s, signed(keys[0], state(1), 41), listed);
  assert.deepEqual(first, { head: state(1), keyId: keys[0].listed.id, release: 41, stored: true });
  assert.equal(s.rows[0].actor, `release-key:${keys[0].listed.id}`);
  // Same signature again: a no-op. Reads: project, State rows, latest release.
  assert.equal((await put(s, signed(keys[0], state(1), 41), listed)).stored, false);
  // Mismatch with the State's existing number, and not above another State's.
  await assert.rejects(put(s, signed(keys[1], state(1), 40), listed), is('RELEASE_NUMBER_MISMATCH'));
  await assert.rejects(put(s, signed(keys[1], state(2), 41), listed), is('RELEASE_NUMBER_NOT_NEWER'));
  await assert.rejects(put(s, signed(keys[1], state(2), 12), listed), is('RELEASE_NUMBER_NOT_NEWER'));
  // Up to 4 per State, then refused.
  for (const key of keys.slice(1, 4))
    assert.equal((await put(s, signed(key, state(1), 41), listed)).stored, true);
  await assert.rejects(put(s, signed(keys[4], state(1), 41), listed), is('RELEASE_SIGNATURE_LIMIT'));
  assert.equal(s.rows.length, 4);
  // A removed project takes nothing, even with a valid signature.
  await assert.rejects(put(s, signed(keys[0], state(3), 50, 'removed'), listed), is('PROJECT_UNAVAILABLE'));
  assert.equal(s.rows.length, 4);
});

test('signer read: a key proof returns main and its release number; bad or stale proofs read nothing', async () => {
  const s = context({ main: state(7), revision: 99 }),
    key = releaseKey(),
    keys = [key.listed],
    now = 1_800_000_000_000,
    at = now / 1000;
  const proof = (head, when = at, projectId = project) => ({
    projectId: project,
    head,
    keyId: key.listed.id,
    at: when,
    proof: key.sign(cliReleaseReadStatement(projectId, head, when)),
  });
  const read = (input, k = keys) => store.signerMainRead(s.ctx, input, k, now);
  for (const input of [
    { ...proof(state(7)), head: state(8) },
    proof(state(7), at, 'elsewhere'),
    proof(state(7), at - 301),
    proof(state(7), at + 301),
    { ...proof(state(7)), proof: signed(key, state(7), 99).signature },
  ])
    await assert.rejects(read(input), is('RELEASE_SIGNATURE_INVALID'));
  await assert.rejects(read(proof(state(7)), [releaseKey().listed]), is('RELEASE_SIGNATURE_INVALID'));
  assert.deepEqual(s.reads, { get: 0, index: 0 });
  // Main's newest: project, main, and the State's signatures (3 reads).
  assert.deepEqual(await read(proof(state(7))), { main: state(7), release: 99, newest: true, signed: false });
  assert.deepEqual(s.reads, { get: 1, index: 2 });
  // An older State: told it is not main's newest; its signatures are not read.
  assert.deepEqual(await read(proof(state(6))), {
    main: state(7),
    release: 99,
    newest: false,
    signed: false,
  });
  assert.deepEqual(s.reads, { get: 2, index: 3 });
  await put(s, signed(key, state(7), 99), keys);
  assert.equal((await read(proof(state(7)))).signed, true);
});

const tipScript = () => {
  const workflow = readFileSync('.github/workflows/release-sign.yml', 'utf8');
  const block = workflow.match(/- id: tip\n[\s\S]*?run: \|\n((?: {10}.*\n)+)/);
  assert(block, 'the tip step keeps its run block');
  return block[1].replace(/^ {10}/gm, '');
};

/** The real tip step, with a stub `gh` that answers GitHub's compare for each commit. */
function runTip(sha, status) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-release-tip-'));
  try {
    const gh = join(dir, 'gh');
    writeFileSync(gh, status === null ? '#!/bin/sh\nexit 1\n' : `#!/bin/sh\necho ${status}\n`);
    chmodSync(gh, 0o755);
    const output = join(dir, 'output');
    writeFileSync(output, '');
    execFileSync('bash', ['-c', tipScript()], {
      env: { PATH: `${dir}:/usr/bin:/bin`, GH_TOKEN: 'x', REPO: 'o/r', SHA: sha, GITHUB_OUTPUT: output },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return readFileSync(output, 'utf8').trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('workflow: one concurrency group that queues, never cancels a running signer', () => {
  const workflow = readFileSync('.github/workflows/release-sign.yml', 'utf8');
  assert.match(workflow, /^concurrency:\n  group: release-sign\n  cancel-in-progress: false$/m);
  assert.match(workflow, /^ {4}environment: release-sign$/m);
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main' && vars\.FORGE_RELEASE_PROJECT != ''/);
  const jobs = workflow.slice(workflow.indexOf('\njobs:\n')).match(/^ {2}[\w-]+:$/gm);
  assert.deepEqual(jobs, ['  sign:'], 'exactly one job per signing');
  assert.equal((workflow.match(/secrets\.FORGE_RELEASE_SIGNING_KEY/g) ?? []).length, 1);
});

test('mirror backlog replay: only the head commit signs, with two Convex calls; older runs cost none', async () => {
  const s = context({ main: state(25), revision: 125 }),
    key = releaseKey(),
    keys = [key.listed],
    calls = [];
  // The fake Convex HTTP API runs the store's own handlers.
  const fetch = async (url, init) => {
    const { path, args } = JSON.parse(init.body);
    calls.push(path);
    try {
      const value =
        path === 'projectReleaseSignatures:signerMain'
          ? await store.signerMainRead(s.ctx, args, keys)
          : await store.putReleaseSignature(s.ctx, args, keys);
      return { status: 200, json: async () => ({ status: 'success', value: JSON.stringify(value) }) };
    } catch (error) {
      return {
        status: 560,
        json: async () => ({
          status: 'error',
          errorData: error.data ?? { code: error.code, message: error.message },
        }),
      };
    }
  };
  const commit = n => ({
    sha: n.toString(16).padStart(40, 'c'),
    message: `Change ${n}\n\nForge-State: ${state(n)}\nForge-Acceptance: a\n`,
  });
  const backlog = Array.from({ length: 6 }, (_, i) => commit(20 + i));
  const head = backlog.at(-1);
  // GitHub's concurrency keeps one running and one pending run; the drain runs the first and the
  // last. Replay every commit anyway, as if each run reached the tip step.
  const results = [];
  for (const c of backlog) {
    const tip = runTip(c.sha, c === head ? 'identical' : 'ahead');
    if (tip !== 'sign=true') {
      results.push('skipped by tip');
      continue;
    }
    results.push(
      (
        await signRelease({
          message: c.message,
          url: 'https://forge.example',
          projectId: project,
          privateKeyPem: key.pem,
          request: fetch,
          keys,
        })
      ).action,
    );
  }
  assert.deepEqual(results, [...Array(5).fill('skipped by tip'), 'signed']);
  assert.deepEqual(calls, ['projectReleaseSignatures:signerMain', 'projectReleaseSignatures:put']);
  assert.equal(s.rows.length, 1);
  assert.equal(s.rows[0].head, state(25));
  assert.equal(s.rows[0].release, 125);
  // The stored signature verifies with the v2 statement for that project id.
  assert.equal(s.rows[0].signature, key.sign(cliReleaseStatement(project, state(25), 125)));
});

test('signer: an unreadable compare still refuses a State that is no longer main, and a signed State is skipped', async () => {
  const s = context({ main: state(9), revision: 10 }),
    key = releaseKey(),
    keys = [key.listed],
    calls = [];
  const fetch = async (url, init) => {
    const { path, args } = JSON.parse(init.body);
    calls.push(path);
    const value =
      path === 'projectReleaseSignatures:signerMain'
        ? await store.signerMainRead(s.ctx, args, keys)
        : await store.putReleaseSignature(s.ctx, args, keys);
    return { status: 200, json: async () => ({ status: 'success', value: JSON.stringify(value) }) };
  };
  const run = n =>
    signRelease({
      message: `x\n\nForge-State: ${state(n)}\n`,
      url: 'https://forge.example',
      projectId: project,
      privateKeyPem: key.pem,
      request: fetch,
      keys,
    });
  assert.equal(runTip('c'.repeat(40), null), 'sign=true');
  const stale = await run(8);
  assert.equal(stale.action, 'skipped');
  assert.match(stale.reason, /no longer main's newest/);
  assert.equal((await run(9)).action, 'signed');
  assert.equal((await run(9)).action, 'skipped');
  assert.deepEqual(calls, [
    'projectReleaseSignatures:signerMain',
    'projectReleaseSignatures:signerMain',
    'projectReleaseSignatures:put',
    'projectReleaseSignatures:signerMain',
  ]);
  // No trailer, or an unlisted key: no call at all.
  assert.equal(
    (
      await signRelease({
        message: 'no trailer',
        url: 'x',
        projectId: project,
        privateKeyPem: key.pem,
        request: fetch,
        keys,
      })
    ).action,
    'skipped',
  );
  await assert.rejects(
    signRelease({
      message: `x\n\nForge-State: ${state(9)}\n`,
      url: 'https://forge.example',
      projectId: project,
      privateKeyPem: releaseKey().pem,
      request: fetch,
      keys,
    }),
    /not in CLI_RELEASE_KEYS/,
  );
  assert.equal(calls.length, 4);
  assert.equal(
    forgeStateTrailer(`a\n\nForge-State: ${state(1)}\n\nb\n\nForge-State: ${state(2)}\n`),
    state(2),
  );
});
