// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { ForgeError, invariant } from './errors.js';
import { forgeSecretId, equalBytes } from './sealed-format.js';
import { sealedClientForRoot } from './sealed-cli.js';
import type { SealedClient } from './sealed-client.js';
import { decodeMachineBundle, machineReadToken } from './sealed-machine.js';
import { sealedRead, type MachineSealedTransport } from './sealed-transport.js';
import { verifySealedReply } from './sealed-verify.js';
import { hostedAgentAddress } from './hosted-agent-address.js';
import type { RunSecretProvider } from './secret-run.js';

/** `nforge run` for one device: a verified cached read. A joining device posts its own request and waits
 * (SECRETS_WAITING); a holder device also shares Development with waiting devices on this run (design 5.1). */
export async function sealedRunFor(client: SealedClient, set: 'development' | 'checks') {
  invariant(
    set === 'development',
    'SECRETS_NOT_SET_UP',
    'Checks runs with a machine key: give this step FORGE_SECRETS_KEY (nforge secret machine add LABEL --set checks).',
  );
  const result = await client.read(true);
  invariant(
    result,
    'SECRETS_NOT_SET_UP',
    'Development is not set up. The owner runs nforge secret set NAME.',
  );
  result.key?.fill(0);
  return { secrets: result.secrets };
}
/** Design 4.15: a CI machine verifies its set from its bundle's roster (its only memory) and the bundle's head floor,
 * then opens its own wrap. Any CI: the bundle, the deployment URL and the project id are all it needs. */
export async function machineRunFor(input: {
  bundle: string;
  forgeProjectId: string;
  transport: Pick<MachineSealedTransport, 'read'>;
}) {
  const b = decodeMachineBundle(input.bundle);
  const token = machineReadToken(b);
  try {
    invariant(
      b.setKind === 2,
      'SECRETS_NOT_SET_UP',
      'This machine key is not for Checks; nforge run --set checks needs a Checks machine key.',
    );
    invariant(
      equalBytes(forgeSecretId('project', input.forgeProjectId), b.projectId),
      'SECRETS_ROSTER_REFUSED',
      'This machine key belongs to another project.',
    );
    const wire = await input.transport.read({
      kind: 2,
      machineId: Uint8Array.from(b.machineId).buffer,
      token: Uint8Array.from(token).buffer,
    });
    invariant(wire, 'SECRETS_NOT_SET_UP', 'Checks is not set up.');
    try {
      const verified = verifySealedReply(sealedRead(wire), null, {
        forgeProjectId: input.forgeProjectId,
        setKind: 2,
        machine: true,
        machineAnchor: b.roster,
        headFloor: b.headFloor,
        recipient: { id: b.machineId, enc: b.enc, kind: 2 },
      });
      verified.key?.fill(0);
      return { secrets: verified.secrets, machine: true };
    } catch (error) {
      if (error instanceof ForgeError && error.code === 'SECRETS_PIN_TOO_OLD')
        throw new ForgeError(
          'SECRETS_PIN_TOO_OLD',
          'This machine key was made before the Checks history Forge keeps. The owner makes a new one: nforge secret machine add LABEL --set checks.',
        );
      throw error;
    }
  } finally {
    token.fill(0);
    b.enc.fill(0);
  }
}
/** Where a machine reads: the Forge checkout it runs in, else FORGE_DEPLOYMENT_URL and FORGE_PROJECT_ID (names, not
 * secrets; a CI checkout of a mirror has no Forge marker). */
export function machineAddress(root: string, source: NodeJS.ProcessEnv) {
  let address: { url: string; projectId: string } | null = null;
  try {
    address = hostedAgentAddress(root, {});
  } catch {
    address = null;
  }
  const url = source.FORGE_DEPLOYMENT_URL ?? address?.url,
    projectId = source.FORGE_PROJECT_ID ?? address?.projectId;
  invariant(
    url && projectId,
    'PROJECT_UNAVAILABLE',
    'Run inside a Forge checkout, or give this step FORGE_DEPLOYMENT_URL and FORGE_PROJECT_ID.',
  );
  return { url, projectId };
}
export const sealedRunSecrets: RunSecretProvider = async input => {
  const source = input.source ?? process.env;
  if (input.set === 'checks') {
    const bundle = source.FORGE_SECRETS_KEY;
    invariant(
      bundle,
      'SECRETS_NOT_SET_UP',
      'Checks runs with a machine key: give this step FORGE_SECRETS_KEY (nforge secret machine add LABEL --set checks).',
    );
    const { url, projectId } = machineAddress(input.root, source);
    const { machineSealedTransport } = await import('./sealed-transport.js');
    return machineRunFor({
      bundle,
      forgeProjectId: projectId,
      transport: machineSealedTransport(url, projectId),
    });
  }
  const client = await sealedClientForRoot(input.root);
  try {
    return await sealedRunFor(client, input.set);
  } finally {
    for (const key of [client.keys.sign, client.keys.enc, client.keys.pinKey]) key.fill(0);
  }
};
