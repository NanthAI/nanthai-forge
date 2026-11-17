// SPDX-License-Identifier: Apache-2.0
import '../check-runtime.mjs';
import { writeSync } from 'node:fs';
import { join } from 'node:path';
import { FileKeyStore, secretLocked } from '../../dist/sealed-local.js';
import { SecretPins } from '../../dist/sealed-pins.js';
import { fixture } from '../helpers/sealed-fixture.mjs';
const [mode,directory,project]=process.argv.slice(2);
if(mode==='hold') await secretLocked(join(directory,'pins.lock'),()=>{writeSync(1,'ready\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);});
else {
  const f=fixture(17,project),pins=new SecretPins(directory,new FileKeyStore(join(directory,'device.bin')));
  for(let i=0;i<12;i++){if(i)f.bump();f.name();await pins.verifyAndSave(f.reply,f.request,i);}
  writeSync(1,'done\n');
}
