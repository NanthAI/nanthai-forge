// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { recoverLocalApply } from '../dist/hosted-apply-recovery.js';
import { clientCacheRoot } from '../dist/root-paths.js';

const { root, request, objects, boundary, timing } = JSON.parse(fs.readFileSync(0, 'utf8'));
const bytes = new Map(objects.map(([id, bytes]) => [id, Buffer.from(bytes, 'base64')]));
const transport = {
  select: async () => request.lane,
  objects: async ids => ids.map(sha256 => ({ sha256, size: bytes.get(sha256).length })),
  downloadToFile: async (pin, path) => fs.writeFileSync(path, bytes.get(pin.sha256)),
};
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  const receipt = String(to).endsWith('/receipt.json');
  const data =
    receipt || String(to).endsWith(`/${request.operationId}.json`) ? JSON.parse(fs.readFileSync(from)) : null;
  const rounds = Object.keys(data?.rounds ?? {}).length;
  const kills = {
    receipt: () => receipt && !data.restored && !data.priorPreservedAt,
    // The first round's changed files are copied and its receipt names them.
    'round-recorded': () => receipt && !data.restored && rounds === 1,
    // A baseline file moves from the private stage into the live tree.
    install: () => String(from).includes('/baseline-') && String(to).startsWith(`${root}/`),
    'prior-backup': () =>
      from === join(clientCacheRoot(root), 'previous') && String(to).endsWith('/prior-checkout'),
    'restored-receipt': () => receipt && data.restored,
    'apply-publication': () =>
      (String(from).includes('/checkout-') && to === root) ||
      (String(from).includes('/delta-') && String(to).startsWith(`${root}/`)),
    'additional-receipt': () => receipt && !data.restored && data.additionalPreservedAt?.length,
    // The second round's changed files are copied and its receipt names them.
    'additional-preserve': () => receipt && !data.restored && rounds === 2,
  };
  if (boundary !== 'apply-receipt' && !kills[boundary]) throw Error(`Unknown crash boundary ${boundary}`);
  const match = boundary === 'apply-receipt' ? data?.complete === true : Boolean(kills[boundary]());
  if (match && timing === 'before') process.kill(process.pid, 'SIGKILL');
  const result = rename(from, to);
  if (match && timing === 'after') process.kill(process.pid, 'SIGKILL');
  return result;
};
syncBuiltinESMExports();
await recoverLocalApply(root, request.operationId, transport);
throw Error('Requested crash boundary was not reached');
