// SPDX-License-Identifier: Apache-2.0
import { runSmallSourceSave } from '../dist/hosted-source-small-save.js';
import { buildSavePages, saveBytes } from '../dist/hosted-save.js';
import { digest } from '../dist/state/hash.js';
const objects = new Map();
const put = bytes => {
  const pin = { sha256: digest(bytes), size: bytes.length };
  objects.set(pin.sha256, bytes);
  return pin;
};
const json = value => put(saveBytes(value));
const original = put(new TextEncoder().encode('original\n'));
const files = Array.from({ length: 35000 }, (_, i) => ({
  path: `src/${String(i).padStart(6, '0')}.ts`,
  blob: original.sha256,
  mode: 'file',
}));
const at = '2026-01-01T00:00:00.000Z';
const baseline = json({ schema: 1, kind: 'forge-source-state', parents: [], files, message: 'baseline', at });
const blob = put(new TextEncoder().encode('changed\n'));
const pages = buildSavePages([
  {
    path: files[0].path,
    before: { blob: original.sha256, mode: 'file' },
    after: { blob: blob.sha256, mode: 'file', content: { object: blob, recipe: null } },
  },
]);
for (const page of pages.pages) json(page.value);
const input = json({
  schema: 1,
  kind: 'forge-hosted-save-input',
  baseline: { object: baseline, recipe: null },
  pages: pages.root,
  pageCount: 1,
  changeCount: 1,
  message: 'saved',
  at,
});
const output = await runSmallSourceSave(input, {
  read: async pin =>
    (async function* () {
      yield objects.get(pin.sha256);
    })(),
  upload: async (_pin, stream) => {
    for await (const bytes of stream) put(bytes);
  },
});
if (!output) throw Error('upper-bound fixture fell back');
console.log(
  JSON.stringify({
    files: files.length,
    baselineBytes: baseline.size,
    heapUsed: process.memoryUsage().heapUsed,
    arrayBuffers: process.memoryUsage().arrayBuffers,
    maxRssBytes: process.resourceUsage().maxRSS * 1024,
  }),
);
