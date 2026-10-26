// SPDX-License-Identifier: Apache-2.0
// Isolated source preparation + client recipe dispatch. No provider/network timing.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const [requestPath, outputPath] = process.argv.slice(2);
if (!requestPath || !outputPath || existsSync(outputPath))
  throw Error('Select REQUEST_JSON and a new RESULT_JSON.');
const request = JSON.parse(readFileSync(requestPath, 'utf8'));
const { ConvexExchange } = await import(pathToFileURL(join(request.runtime, 'dist/exchange-client.js')));
const { readSource } = await import(pathToFileURL(join(request.runtime, 'dist/files.js')));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const client = new ConvexExchange(
  'https://fixture.convex.cloud',
  'private-fixture',
  'project',
  'operation',
  null,
);
const stored = new Set(request.stored ?? []),
  sent = new Map();
let recipe;
client.missing = async pins => pins.filter(pin => !stored.has(pin.sha256)).map(pin => pin.sha256);
client.uploadPhysical = async objects => {
  let uploadedObjects = 0,
    uploadedBytes = 0;
  for (const object of objects) {
    if (stored.has(object.pin.sha256)) continue;
    const bytes = await object.read();
    if (sha(bytes) !== object.pin.sha256) throw Error('Changed physical content.');
    sent.set(object.pin.sha256, bytes.length);
    stored.add(object.pin.sha256);
    uploadedObjects++;
    uploadedBytes += bytes.length;
  }
  return { uploadedObjects, uploadedBytes };
};
client.uploadRawBatch = objects =>
  client.uploadPhysical(objects.map(object => ({ pin: object.pin, read: () => object.bytes })));
client.client.action = async (_, args) => {
  recipe = args;
  return null;
};
const started = performance.now(),
  cpu = process.cpuUsage();
let receipt;
if (request.mode === 'streamed')
  receipt = await client.uploadFile(request.pin, dirname(request.source), basename(request.source));
else if (request.mode === 'buffered') {
  const bytes = readSource(
    dirname(request.source),
    basename(request.source),
    request.pin.size + 1,
    request.pin.sha256,
  );
  if (!bytes || bytes.length !== request.pin.size || sha(bytes) !== request.pin.sha256)
    throw Error('Source changed.');
  receipt = await client.upload(request.pin, bytes);
} else throw Error('Select buffered or streamed.');
writeFileSync(
  outputPath,
  JSON.stringify(
    {
      request,
      node: process.version,
      elapsedMs: performance.now() - started,
      cpu: process.cpuUsage(cpu),
      maxRSS: process.resourceUsage().maxRSS,
      receipt,
      recipe,
      sent: [...sent],
      qualification:
        'Isolated same-file client dispatch with authenticated physical-hash sink; provider/network and prepareNativeExchange excluded. OS cache uncontrolled; maxRSS is whole child process.',
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
