// SPDX-License-Identifier: Apache-2.0
import '../check-runtime.mjs';
import { copyFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { FileKeyStore, secretLocked } from '../../dist/sealed-local.js';
import { SecretPins } from '../../dist/sealed-pins.js';
import { fixture } from '../helpers/sealed-fixture.mjs';
const [mode, directory, argument] = process.argv.slice(2);
if (mode === 'hold' || mode === 'hold-key-write') {
  await secretLocked(join(directory, 'pins.lock'), () => {
    if (mode === 'hold-key-write') copyFileSync(join(directory, 'device.bin'), join(directory, argument));
    writeSync(1, 'ready\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  });
} else {
  const f = fixture(17, argument);
  const pins = new SecretPins(directory, new FileKeyStore(join(directory, 'device.bin')));
  for (let index = 0; index < 12; index++) {
    if (index) f.bump();
    f.name();
    await pins.verifyAndSave(f.reply, f.request, index);
  }
  writeSync(1, 'done\n');
}
