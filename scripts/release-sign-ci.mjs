// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Automated CLI release signer (docs/operations/cli-update.md, "Automated signer"). Run by
// .github/workflows/release-sign.yml in the `release-sign` environment with plain Node: no install,
// no build. It signs the Forge State that Forge dispatched it with (FORGE_RELEASE_STATE), or on a
// manual run the State named by the checked-out commit's Forge-State trailer, and only while that
// State is still main's newest; when a newer main has passed it, it signs that newest State instead.
// Two Convex calls per signing (one read, one write), one more when it moves to a newer main, one
// when it skips. The private key arrives in FORGE_RELEASE_SIGNING_KEY, is removed from the environment
// before anything else runs, stays in memory and is never printed or written to disk.
import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CLI_RELEASE_KEYS } from '../src/cli-release-keys.ts';
import { cliReleaseReadStatement, cliReleaseStatement } from '../src/cli-release-statement.ts';

const fail = (code, message) => Object.assign(new Error(message), { code });

/** The State of the commit: the last `Forge-State:` trailer line, or null when there is none. */
export function forgeStateTrailer(message) {
  return [...String(message).matchAll(/^Forge-State: ([0-9a-f]{64})$/gm)].at(-1)?.[1] ?? null;
}

function releaseKey(pem) {
  let key;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw fail('CLI_RELEASE_KEY_INVALID', 'FORGE_RELEASE_SIGNING_KEY is not a PKCS#8 PEM private key.');
  }
  if (key.asymmetricKeyType !== 'ed25519')
    throw fail('CLI_RELEASE_KEY_INVALID', 'FORGE_RELEASE_SIGNING_KEY is not an Ed25519 key.');
  const raw = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(12);
  return { key, keyId: createHash('sha256').update(raw).digest('hex').slice(0, 16) };
}

/** One Convex HTTP API call; the function's own JSON string comes back parsed. */
async function convexCall(request, url, kind, path, args) {
  const response = await request(`${url}/api/${kind}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, args, format: 'json' }),
    signal: AbortSignal.timeout(20_000),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw fail('HOSTED_PROTOCOL_INVALID', `${path} answered HTTP ${response.status} without JSON.`);
  }
  if (body?.status !== 'success')
    throw fail(
      body?.errorData?.code ?? 'HOSTED_ACTION_FAILED',
      body?.errorData?.message ?? `${path} failed.`,
    );
  return typeof body.value === 'string' ? JSON.parse(body.value) : body.value;
}

/** Sign one State: `state` when Forge dispatched it, else the commit message's trailer. Returns what
 * it did; throws a coded error on refusal or failure. */
export async function signRelease({
  state,
  message,
  url,
  projectId,
  privateKeyPem,
  request = globalThis.fetch,
  now = Date.now,
  keys = CLI_RELEASE_KEYS,
}) {
  if (state && !/^[0-9a-f]{64}$/.test(state))
    throw fail('BAD_ARGUMENT', 'FORGE_RELEASE_STATE must be a full Forge State hash.');
  let head = state || forgeStateTrailer(message);
  if (!head) return { action: 'skipped', reason: 'the commit has no Forge-State trailer' };
  if (!/^https:\/\/[^/\s]+$/.test(url ?? ''))
    throw fail('BAD_ARGUMENT', 'Set FORGE_RELEASE_URL to the https Convex deployment URL.');
  if (!/^[a-z0-9]{16,64}$/.test(projectId ?? ''))
    throw fail('BAD_ARGUMENT', 'Set FORGE_RELEASE_PROJECT to the Forge project id.');
  const { key, keyId } = releaseKey(privateKeyPem);
  if (!keys.some(entry => entry.id === keyId))
    throw fail('CLI_RELEASE_KEY_UNLISTED', `Release key ${keyId} is not in CLI_RELEASE_KEYS.`);
  const read = async state => {
    const at = Math.floor(now() / 1000);
    const proof = sign(null, Buffer.from(cliReleaseReadStatement(projectId, state, at)), key).toString(
      'base64',
    );
    return convexCall(request, url, 'query', 'projectReleaseSignatures:signerMain', {
      projectId,
      head: state,
      keyId,
      at,
      proof,
    });
  };
  let main = await read(head);
  // A newer main passed the State this run started from (a late or replaced dispatch, a manual run
  // on GitHub's older main): sign the newest instead, so whichever run goes last leaves main signed.
  const from = head;
  if (!main.newest && /^[0-9a-f]{64}$/.test(main.main ?? '')) {
    head = main.main;
    main = await read(head);
  }
  if (!main.newest)
    return {
      action: 'skipped',
      reason: "the State is no longer main's newest",
      head,
      main: main.main,
      keyId,
    };
  if (main.signed)
    return { action: 'skipped', reason: 'the State already has a v2 signature from this key', head, keyId };
  const release = main.release;
  const signature = sign(null, Buffer.from(cliReleaseStatement(projectId, head, release)), key).toString(
    'base64',
  );
  const put = await convexCall(request, url, 'mutation', 'projectReleaseSignatures:put', {
    projectId,
    head,
    keyId,
    signature,
    release,
  });
  return {
    action: put.stored ? 'signed' : 'unchanged',
    head,
    release,
    keyId,
    ...(from === head ? {} : { from }),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // Take the key out of the environment first, so no child process (git) can inherit it.
  const privateKeyPem = process.env.FORGE_RELEASE_SIGNING_KEY ?? '';
  delete process.env.FORGE_RELEASE_SIGNING_KEY;
  try {
    if (!privateKeyPem)
      throw fail('CLI_RELEASE_KEY_MISSING', 'The release-sign environment has no FORGE_RELEASE_SIGNING_KEY.');
    const state = process.env.FORGE_RELEASE_STATE ?? '';
    const message = state
      ? ''
      : execFileSync('git', ['log', '-1', '--format=%B', 'HEAD'], { encoding: 'utf8' });
    const result = await signRelease({
      state,
      message,
      url: process.env.FORGE_RELEASE_URL,
      projectId: process.env.FORGE_RELEASE_PROJECT,
      privateKeyPem,
    });
    console.log(JSON.stringify(result));
    console.log(`::notice::Release ${result.action}${result.reason ? `: ${result.reason}` : ''}.`);
  } catch (error) {
    console.log(`::error::${error.code ?? 'RELEASE_SIGN_FAILED'}: ${error.message}`);
    process.exitCode = 1;
  }
}
