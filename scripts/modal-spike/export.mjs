// SPDX-License-Identifier: Apache-2.0
// Export one exact native State without Git ancestry, Work records or credentials.
import { NativeSource } from '../../dist/native-source.js';
import { writeFileSync } from 'node:fs';

const [owner, head, destination, manifest] = process.argv.slice(2);
if (!owner || !/^[a-f0-9]{64}$/.test(head ?? '') || !destination || !manifest)
  throw new Error('Usage: node scripts/modal-spike/export.mjs OWNER HEAD NEW_DIRECTORY NEW_MANIFEST');
const source = new NativeSource(owner);
const bytes = source.object(head);
source.state(head); // Validate the State before materializing source bytes.
source.materialize(head, destination, false);
writeFileSync(manifest, bytes, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ head, destination, manifest }));
