// SPDX-License-Identifier: Apache-2.0
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { isMachineRunner } from './hosted-machine-runner.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { invariant } from './errors.js';

/** A runner machine's signing key is derived from the deployment key for exactly
 * one project and one registered machine, so nothing new is stored and a key
 * issued to one machine is worthless for any other project or machine. The
 * deployment key itself stays on the backend. */
export function machineCollectorKey(
  deploymentKey: string,
  scope: { keyId: string; projectId: string; machineId: string },
) {
  invariant(deploymentKey.length > 0, 'RUNNER_UNAVAILABLE', 'Trusted output key is unavailable.');
  invariant(
    scope.keyId.length > 0 && scope.projectId.length > 0 && scope.machineId.length > 0,
    'RUNNER_UNAVAILABLE',
    'A collector key needs one exact project and machine.',
  );
  const info = canonicalPayload({
    domain: 'forge-hosted-collector-key-v1',
    keyId: scope.keyId,
    projectId: scope.projectId,
    machineId: scope.machineId,
  });
  return bytesToHex(hkdf(sha256, utf8ToBytes(deploymentKey), undefined, utf8ToBytes(info), 32));
}

/** The secret that signs a run's collector evidence. Machine runs use their
 * machine's derived key; provider runs are signed by the backend only. */
export function runSigningSecret(
  deploymentKey: string,
  run: { projectId: string; keyId: string; configuration: { provider: string; machineId?: string } },
) {
  return isMachineRunner(run.configuration)
    ? machineCollectorKey(deploymentKey, {
        keyId: run.keyId,
        projectId: run.projectId,
        machineId: run.configuration.machineId,
      })
    : deploymentKey;
}
