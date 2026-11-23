// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { ShotError } from './options.mjs';

export const botHandle = 'forge-ui-bot';
const nonempty = value => typeof value === 'string' && value.length > 0;
const base64 = value => nonempty(value) && /^[A-Za-z0-9+/]+={0,2}$/.test(value);

function origin(value) {
  if (!nonempty(value)) return null;
  try {
    const url = new URL(value);
    return url.origin === value && url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

export async function readBotCredentials(file, base) {
  let raw;
  try {
    const input = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await input.stat();
      if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid?.())
        throw new ShotError('Bot credentials must be a user-owned 0600 regular file.');
      raw = JSON.parse(await input.readFile('utf8'));
    } finally {
      await input.close();
    }
  } catch (error) {
    if (error instanceof ShotError) throw error;
    throw new ShotError('Could not read the private bot credentials file.');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new ShotError('Invalid bot credentials file.');
  const projectId = nonempty(raw.projectId) ? raw.projectId : undefined;
  if (!Object.hasOwn(raw, 'passkey'))
    throw new ShotError('Bot credentials need a passkey. Run node scripts/ui-bot-setup.mjs --passkey.');
  return { ...botPasskey(raw.passkey, base), projectId };
}

export function botPasskey(entry, base) {
  const { origin: webOrigin, deployment, credential } = entry ?? {};
  const web = origin(webOrigin);
  const backend = origin(deployment);
  const { credentialId, privateKey, rpId, userHandle } = credential ?? {};
  if (
    !web ||
    !backend ||
    !nonempty(rpId) ||
    !(web.hostname === rpId || web.hostname.endsWith(`.${rpId}`)) ||
    ![credentialId, privateKey, userHandle].every(base64) ||
    credential?.isResidentCredential !== true
  )
    throw new ShotError(
      'Bot passkey credentials need an HTTPS web origin, deployment and resident credential.',
    );
  if (new URL(base).origin !== webOrigin)
    throw new ShotError('The requested site does not match the bot passkey web origin.');
  return {
    kind: 'passkey',
    origin: webOrigin,
    deployment,
    // Enroll this tooling credential with a zero counter and keep it counterless across fresh browser contexts.
    credential: { credentialId, privateKey, rpId, userHandle, isResidentCredential: true, signCount: -1 },
  };
}
