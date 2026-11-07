// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLI_RELEASE_KEYS,
  CLI_RELEASE_SIGNATURES_REQUIRED,
  CLI_RELEASE_SIGNATURE_RETRY_MS,
  cliReleaseKeyId,
  cliReleasePublicKey,
  signCliRelease,
  verifyCliRelease,
} from '../dist/cli-release-trust.js';
import { cliReleaseSignaturesSchema, cliReleaseStatement } from '../dist/cli-release-signature.js';
import { readCliReleaseNumber, releaseNumberPath, releaseVerdictPath } from '../dist/cli-release-check.js';
import { cliReleaseKey, cliReleaseSign } from '../dist/cli-release-sign.js';
import { cliCanaryNotice, readCliCanaryRefusal, RELEASE_SIGNATURE_STEP } from '../dist/cli-canary.js';
import { updateCli } from '../dist/cli-update.js';
import { cliBuildCommit, selectCliBuild } from '../dist/cli-installation.js';

const a = 'a'.repeat(64),
  b = 'b'.repeat(64),
  c = 'c'.repeat(64);
const address = { url: 'https://synthetic.convex.cloud', projectId: 'forge-source' };
function releaseKey() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  const publicKey = cliReleasePublicKey(privateKey);
  return { pem, key: { id: cliReleaseKeyId(publicKey), publicKey } };
}

test('compiled release trust: key ids match their keys and signatures are never required without a key', () => {
  const ids = new Set();
  for (const key of CLI_RELEASE_KEYS) {
    assert.equal(key.id, cliReleaseKeyId(key.publicKey));
    assert.ok(!ids.has(key.id), `duplicate release key ${key.id}`);
    ids.add(key.id);
  }
  if (CLI_RELEASE_SIGNATURES_REQUIRED) assert.ok(CLI_RELEASE_KEYS.length > 0, 'required needs a listed key');
  assert.equal(cliReleaseStatement('p', a), `forge-cli-release/v1\nproject p\nstate ${a}\n`);
  assert.equal(cliReleaseStatement('p', a, 7), `forge-cli-release/v2\nproject p\nstate ${a}\nrelease 7\n`);
});

test('verification accepts a listed key, refuses a mismatched one and ignores unknown keys', () => {
  const one = releaseKey(),
    other = releaseKey();
  const good = signCliRelease(one.pem, address.projectId, b);
  const verify = (signatures, keys = [one.key], head = b, projectId = address.projectId) =>
    verifyCliRelease({ projectId, head, signatures, keys });
  assert.deepEqual(verify([good]), { status: 'verified', keyId: one.key.id });
  // Other State, other project or altered bytes: the listed key's signature does not match.
  assert.equal(verify([good], [one.key], c).status, 'invalid');
  assert.equal(verify([good], [one.key], b, 'another-project').status, 'invalid');
  const bytes = Buffer.from(good.signature, 'base64');
  bytes[0] ^= 1;
  assert.equal(verify([{ ...good, signature: bytes.toString('base64') }]).status, 'invalid');
  // One good signature among several is enough (rotation signs with every listed key).
  assert.equal(
    verify([signCliRelease(other.pem, address.projectId, b), good], [other.key, one.key]).status,
    'verified',
  );
  // Missing, unreadable or only from keys this build does not list: unsigned, never valid.
  assert.equal(verify([]).status, 'unsigned');
  assert.equal(verify(null).status, 'unsigned');
  assert.equal(verify([signCliRelease(other.pem, address.projectId, b)]).status, 'unsigned');
  assert.equal(verify([good], []).status, 'unsigned');
  // A numbered (v2) signature binds its release number: an altered number no longer verifies.
  const numbered = signCliRelease(one.pem, address.projectId, b, 12);
  assert.deepEqual(verify([numbered]), { status: 'verified', keyId: one.key.id, release: 12 });
  assert.equal(verify([{ ...numbered, release: 13 }]).status, 'invalid');
  assert.equal(verify([{ keyId: numbered.keyId, signature: numbered.signature }]).status, 'invalid');
  // The numbered signature wins over a v1 one for the same State.
  assert.equal(verify([good, numbered]).release, 12);
  assert.equal(cliReleaseSignaturesSchema.safeParse({ head: b, signatures: [good, numbered] }).success, true);
  assert.equal(
    cliReleaseSignaturesSchema.safeParse({ head: b, signatures: [{ ...numbered, release: -1 }] }).success,
    false,
  );
  assert.equal(
    cliReleaseSignaturesSchema.safeParse({ head: b, signatures: [good, good, good, good, good] }).success,
    false,
  );
});

function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'forge-test-release-trust-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const settings = join(directory, 'client.json');
  writeFileSync(settings, JSON.stringify({ localHeavySlots: 0 }));
  const previousSettings = process.env.FORGE_CLIENT_SETTINGS;
  process.env.FORGE_CLIENT_SETTINGS = settings;
  t.after(() => {
    if (previousSettings === undefined) delete process.env.FORGE_CLIENT_SETTINGS;
    else process.env.FORGE_CLIENT_SETTINGS = previousSettings;
  });
  const installation = join(directory, 'forge-cli');
  const build = head => {
    const path = join(installation, 'builds', head);
    mkdirSync(join(path, 'dist'), { recursive: true });
    writeFileSync(join(path, '.commit'), head);
    writeFileSync(join(path, '.managed-cli'), '1');
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name: '@nanthai/forge', type: 'module' }));
    writeFileSync(join(path, 'dist', 'cli-version.js'), '// synthetic controller capability');
    copyFileSync(new URL('../dist/cli-launcher.js', import.meta.url), join(path, 'dist', 'cli-launcher.js'));
    writeFileSync(join(path, 'dist', 'cli-entry.js'), '// complete');
    writeFileSync(join(path, 'dist', 'agent-edit-hook.js'), '// complete');
    return path;
  };
  selectCliBuild(installation, build(a));
  return { directory, installation, build };
}
/** An update to main b whose build is already installed, with a signature store and spies. */
function release(f, { signatures = [], trust, fail = false, head = b } = {}) {
  const seen = { reads: [], checkouts: 0, alerts: [] };
  return {
    seen,
    dependencies: {
      source: {
        current: async () => ({ head, projectId: address.projectId }),
        signatures: async head => {
          seen.reads.push(head);
          if (fail) throw new Error('synthetic signature read failure');
          return signatures;
        },
        checkout: async () => {
          seen.checkouts++;
          assert.fail('the release check runs before any download');
        },
      },
      run: async () => assert.fail('the release check runs before any build'),
      migrate: () => {},
      releaseCheck: {
        ...(trust ? { trust } : {}),
        alert: async record => void seen.alerts.push(record),
      },
    },
  };
}

test('transition: an unsigned release still installs, with one signature read and a local verdict', async t => {
  const f = fixture(t);
  for (const options of [{}, { fail: true }]) {
    rmSync(join(f.installation, 'builds', b), { recursive: true, force: true });
    selectCliBuild(f.installation, join(f.installation, 'builds', a));
    f.build(b);
    const { seen, dependencies } = release(f, {
      ...options,
      trust: { keys: [releaseKey().key], required: false },
    });
    const result = await updateCli(f.installation, address, undefined, dependencies);
    assert.equal(result.status, 'updated');
    assert.equal(cliBuildCommit(join(f.installation, 'current')), b);
    assert.deepEqual(seen.reads, [b]);
    assert.deepEqual(seen.alerts, []);
    const verdict = JSON.parse(readFileSync(releaseVerdictPath(f.installation), 'utf8'));
    assert.equal(verdict.head, b);
    assert.equal(verdict.status, 'unsigned');
    assert.equal(verdict.required, false);
  }
  // The compiled default (no test trust) is the transition: same result without a key.
  selectCliBuild(f.installation, join(f.installation, 'builds', a));
  const { dependencies } = release(f);
  delete dependencies.releaseCheck.trust;
  assert.equal(CLI_RELEASE_SIGNATURES_REQUIRED, false);
  assert.equal((await updateCli(f.installation, address, undefined, dependencies)).status, 'updated');
});

test('a good signature installs when signatures are required', async t => {
  const f = fixture(t),
    one = releaseKey();
  f.build(b);
  const { seen, dependencies } = release(f, {
    signatures: [signCliRelease(one.pem, address.projectId, b, 3)],
    trust: { keys: [one.key], required: true },
  });
  assert.equal((await updateCli(f.installation, address, undefined, dependencies)).status, 'updated');
  assert.equal(cliBuildCommit(join(f.installation, 'current')), b);
  assert.deepEqual(seen.reads, [b]);
  assert.deepEqual(readCliReleaseNumber(f.installation), { release: 3, head: b });
  assert.equal(JSON.parse(readFileSync(releaseVerdictPath(f.installation), 'utf8')).status, 'verified');
});

test('a bad signature is refused before download or build, even during the transition, and alerts once', async t => {
  const f = fixture(t),
    one = releaseKey();
  for (const required of [false, true]) {
    rmSync(join(f.installation, 'canary-refused.json'), { force: true });
    const { seen, dependencies } = release(f, {
      // Signed for another State: present, from a listed key, and wrong for this one.
      signatures: [signCliRelease(one.pem, address.projectId, c)],
      trust: { keys: [one.key], required },
    });
    for (let attempt = 1; attempt <= 2; attempt++)
      await assert.rejects(updateCli(f.installation, address, undefined, dependencies), {
        code: 'CLI_CANARY_FAILED',
        message: /Release signature check refused build bbbbbbbb/,
      });
    assert.equal(seen.checkouts, 0);
    assert.equal(existsSync(join(f.installation, 'builds', b)), false);
    assert.equal(cliBuildCommit(join(f.installation, 'current')), a);
    assert.equal(seen.alerts.length, 1, 'one alert per head');
    const refusal = readCliCanaryRefusal(f.installation);
    assert.equal(refusal.step, RELEASE_SIGNATURE_STEP);
    assert.equal(refusal.head, b);
    assert.equal(refusal.attempts, 2);
    assert.equal(refusal.signaturePending, undefined);
    assert.match(cliCanaryNotice(f.installation, refusal, a), /refused by its release signature check/);
  }
});

test('required: a missing signature holds on the current build without an alert until it is published', async t => {
  const f = fixture(t),
    one = releaseKey();
  const signatures = [];
  const { seen, dependencies } = release(f, { signatures, trust: { keys: [one.key], required: true } });
  const before = Date.now();
  await assert.rejects(updateCli(f.installation, address, undefined, dependencies), {
    code: 'CLI_CANARY_FAILED',
    message: /Waiting for the release signature of build bbbbbbbb/,
  });
  const hold = readCliCanaryRefusal(f.installation);
  assert.equal(hold.signaturePending, true);
  assert.equal(hold.attempts, 0);
  assert.ok(hold.nextRetryAt >= before + CLI_RELEASE_SIGNATURE_RETRY_MS);
  assert.deepEqual(seen.alerts, []);
  assert.match(cliCanaryNotice(f.installation, hold, a), /held until its release signature is published/);
  assert.equal(cliBuildCommit(join(f.installation, 'current')), a);
  // Unknown keys and a failed read are the same hold, never an install.
  signatures.push(signCliRelease(releaseKey().pem, address.projectId, b));
  await assert.rejects(updateCli(f.installation, address, undefined, dependencies), {
    code: 'CLI_CANARY_FAILED',
  });
  assert.equal(seen.checkouts, 0);
  // The owner signs; the next attempt installs and clears the hold.
  signatures.push(signCliRelease(one.pem, address.projectId, b, 3));
  f.build(b);
  assert.equal((await updateCli(f.installation, address, undefined, dependencies)).status, 'updated');
  assert.equal(cliBuildCommit(join(f.installation, 'current')), b);
  assert.equal(readCliCanaryRefusal(f.installation), null);
});

test('no signature read when main is already installed, and explicit --state selection skips the check', async t => {
  const f = fixture(t);
  const { seen, dependencies } = release(f, { trust: { keys: [releaseKey().key], required: true } });
  dependencies.source.current = async () => ({ head: a, projectId: address.projectId });
  assert.equal((await updateCli(f.installation, address, undefined, dependencies)).status, 'current');
  assert.deepEqual(seen.reads, []);
  f.build(b);
  const result = await updateCli(
    f.installation,
    address,
    { head: b, projectId: address.projectId },
    dependencies,
    { rollback: true },
  );
  assert.equal(result.cliCommit, b);
  assert.deepEqual(seen.reads, []);
});

test('owner key and signing commands print only public material and refuse an exposed key file', async t => {
  const f = fixture(t);
  writeFileSync(join(f.installation, 'source.json'), JSON.stringify(address));
  const keyFile = join(f.directory, 'release-key.pem');
  const created = cliReleaseKey(keyFile);
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(created), /PRIVATE/);
  assert.deepEqual(Object.keys(created).sort(), ['file', 'keyId', 'publicKey']);
  assert.throws(() => cliReleaseKey(keyFile), { code: 'EEXIST' });
  const stored = [];
  const source = {
    current: async () => ({ head: b, projectId: address.projectId, sourceRevision: 41 }),
    publishSignature: async (head, signed) => {
      stored.push({ head, ...signed });
      return { stored: true };
    },
  };
  const signed = await cliReleaseSign(f.installation, keyFile, undefined, source);
  // The release number defaults to main's source revision.
  assert.deepEqual(signed, { head: b, release: 41, keyId: created.keyId, stored: true, listed: false });
  assert.doesNotMatch(JSON.stringify(signed), /PRIVATE/);
  assert.equal(
    verifyCliRelease({
      projectId: address.projectId,
      head: b,
      signatures: [stored[0]].map(({ keyId, signature, release }) => ({ keyId, signature, release })),
      keys: [{ id: created.keyId, publicKey: created.publicKey }],
    }).release,
    41,
  );
  // An explicit State needs an explicit release number.
  await assert.rejects(cliReleaseSign(f.installation, keyFile, c, source), { code: 'BAD_ARGUMENT' });
  const explicit = await cliReleaseSign(f.installation, keyFile, c, source, 42);
  assert.equal(explicit.head, c);
  assert.equal(explicit.release, 42);
  chmodSync(keyFile, 0o644);
  await assert.rejects(cliReleaseSign(f.installation, keyFile, undefined, source), {
    code: 'CLI_RELEASE_KEY_EXPOSED',
  });
  assert.equal(stored.length, 2);
});

test('anti-downgrade: a valid signature with a lower release number is refused, not verified', async t => {
  const f = fixture(t),
    one = releaseKey();
  const trust = { keys: [one.key], required: false };
  // Main b, signed as release 10, installs and becomes this machine's floor.
  f.build(b);
  const first = release(f, { signatures: [signCliRelease(one.pem, address.projectId, b, 10)], trust });
  assert.equal((await updateCli(f.installation, address, undefined, first.dependencies)).status, 'updated');
  assert.deepEqual(readCliReleaseNumber(f.installation), { release: 10, head: b });
  // An earlier signed State c (release 5) put back on main: the signature is valid, the number is
  // lower, so it is refused before any download, with one alert, during the transition too.
  for (const required of [false, true]) {
    rmSync(join(f.installation, 'canary-refused.json'), { force: true });
    for (const number of [5, 10]) {
      const { seen, dependencies } = release(f, {
        head: c,
        signatures: [signCliRelease(one.pem, address.projectId, c, number)],
        trust: { ...trust, required },
      });
      await assert.rejects(updateCli(f.installation, address, undefined, dependencies), {
        code: 'CLI_CANARY_FAILED',
        message: new RegExp(`Release signature check refused build cccccccc: release ${number} is not newer`),
      });
      assert.equal(seen.checkouts, 0);
      assert.equal(cliBuildCommit(join(f.installation, 'current')), b);
      const verdict = JSON.parse(readFileSync(releaseVerdictPath(f.installation), 'utf8'));
      assert.equal(verdict.status, 'downgrade');
      assert.equal(verdict.release, number);
      assert.equal(verdict.installed, 10);
      assert.equal(readCliCanaryRefusal(f.installation).step, RELEASE_SIGNATURE_STEP);
      assert.equal(seen.alerts.length, number === 5 ? 1 : 0, 'one alert per head');
    }
  }
  // The owner's explicit --state selection installs it and keeps the floor.
  f.build(c);
  const rollback = release(f, { head: c, trust });
  const result = await updateCli(
    f.installation,
    address,
    { head: c, projectId: address.projectId },
    rollback.dependencies,
    { rollback: true },
  );
  assert.equal(result.cliCommit, c);
  assert.deepEqual(rollback.seen.reads, []);
  assert.deepEqual(readCliReleaseNumber(f.installation), { release: 10, head: b });
  // A newer release moves on and raises the floor.
  const d = 'd'.repeat(64);
  f.build(d);
  rmSync(join(f.installation, 'canary-refused.json'), { force: true });
  const next = release(f, {
    head: d,
    signatures: [signCliRelease(one.pem, address.projectId, d, 11)],
    trust,
  });
  assert.equal((await updateCli(f.installation, address, undefined, next.dependencies)).status, 'updated');
  assert.deepEqual(readCliReleaseNumber(f.installation), { release: 11, head: d });
});

test('migration: v1 signatures (no number) verify while signing is optional and are held once required', async t => {
  const f = fixture(t),
    one = releaseKey();
  const legacy = [signCliRelease(one.pem, address.projectId, b)];
  assert.equal(legacy[0].release, undefined);
  f.build(b);
  const optional = release(f, { signatures: legacy, trust: { keys: [one.key], required: false } });
  assert.equal(
    (await updateCli(f.installation, address, undefined, optional.dependencies)).status,
    'updated',
  );
  assert.equal(JSON.parse(readFileSync(releaseVerdictPath(f.installation), 'utf8')).status, 'verified');
  // No number, no floor: nothing to compare later releases with yet.
  assert.equal(existsSync(releaseNumberPath(f.installation)), false);
  selectCliBuild(f.installation, join(f.installation, 'builds', a));
  const required = release(f, { signatures: legacy, trust: { keys: [one.key], required: true } });
  await assert.rejects(updateCli(f.installation, address, undefined, required.dependencies), {
    code: 'CLI_CANARY_FAILED',
    message: /Waiting for the release signature of build bbbbbbbb: signed without a release number/,
  });
  assert.equal(readCliCanaryRefusal(f.installation).signaturePending, true);
  assert.deepEqual(required.seen.alerts, []);
  assert.equal(cliBuildCommit(join(f.installation, 'current')), a);
});
