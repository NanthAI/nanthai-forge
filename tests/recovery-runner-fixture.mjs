// SPDX-License-Identifier: Apache-2.0
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hostedRecoveryFixture } from './recovery-hosted-fixture.mjs';
import { NativeSource } from '../dist/native-source.js';
import { checkEnvironment } from '../dist/check-environment.js';
import { hostedMacRuntime } from '../dist/hosted-mac-lease.js';

export async function runnerRecoveryFixture(t, options) {
  const f = await hostedRecoveryFixture(t, options),
    source = new NativeSource(f.root);
  const configuration = {
    provider: 'mac',
    machineId: randomUUID(),
    runtime: hostedMacRuntime,
    environmentFingerprint: checkEnvironment().fingerprint,
  };
  const registrations = new Map();
  let loseReply = false;
  Object.assign(f.transport, {
    current: async () => {
      await f.transport.prepare();
      return structuredClone(f.selection.hostedMain);
    },
    configuration: async () => configuration,
    downloadToFile: async (pin, path) => writeFileSync(path, await f.transport.download(pin)),
    register: async request => {
      await f.transport.prepare();
      const old = registrations.get(request.operationId);
      if (old && JSON.stringify(old.request) !== JSON.stringify(request))
        throw new Error('registration changed');
      const value = old ?? {
        request,
        receipt: {
          status: 'completed',
          result: {
            projectId: f.selection.projectId,
            machineId: configuration.machineId,
            sessionId: request.operationId,
            configuration: 'synthetic',
            keyId: 'SYNTHETIC',
          },
        },
      };
      registrations.set(request.operationId, value);
      if (loseReply) {
        loseReply = false;
        throw Object.assign(new Error('Synthetic lost registration reply'), { code: 'HOSTED_ACTION_FAILED' });
      }
      return value.receipt;
    },
    reconnect: async () => {
      throw new Error('Route B must never reconnect an owner');
    },
    journal: async () => {
      throw new Error('Route B must never restore the seed owner');
    },
  });
  return {
    ...f,
    source,
    configuration,
    registrations,
    loseRegistrationReply: () => {
      loseReply = true;
    },
  };
}
