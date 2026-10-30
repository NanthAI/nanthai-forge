// SPDX-License-Identifier: Apache-2.0
import { mock } from 'node:test';
import { hostedMachineLifecycleDrill, machineInterruptions } from './hosted-machine-lifecycle-drill.mjs';

const cleanup = [];
try {
  const result = await hostedMachineLifecycleDrill(
    { mock, after: fn => cleanup.push(fn) },
    machineInterruptions[0],
    true,
  );
  console.log(JSON.stringify(result));
} finally {
  for (const fn of cleanup.reverse()) await fn();
  mock.restoreAll();
}
