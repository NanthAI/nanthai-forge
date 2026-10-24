// SPDX-License-Identifier: Apache-2.0
import { getFunctionName } from 'convex/server';
import type { ConvexReactClient } from 'convex/react';
import { readBrowserSource } from '../../web/src/browser-source';
import { downloadObjectArchive } from '../../web/src/object-archive';
import { ObjectDownloadReader } from '../../src/blob-download';
const service = 'http://localhost:5374';
const results: string[] = [];
const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};
const client = () =>
  ({
    async mutation(ref: Parameters<typeof getFunctionName>[0], args: unknown) {
      const method = getFunctionName(ref).split(':')[1];
      const response = await fetch(`${service}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, args }),
      });
      const value = await response.json();
      if (!response.ok) throw Object.assign(new Error('Project access denied.'), value);
      return method === 'source' ? JSON.stringify(value) : value;
    },
  }) as unknown as Pick<ConvexReactClient, 'mutation'>;
const control = (query = '') => fetch(`${service}/control?${query}`).then(response => response.json());
async function run() {
  const f = await fetch(`${service}/fixture`).then(response => response.json());
  const input = { ...f.input, file: 'a.ts' },
    c = client();
  const value = JSON.parse(await readBrowserSource(c, input));
  document.querySelector('#results')!.textContent = value.after.text;
  assert(
    value.after.text === 'export const value = 2;\n' && value.before.text.includes('1'),
    'mixed source rendering',
  );
  assert(
    value.comparison.hunks[0].lines.some((line: { kind: string }) => line.kind === 'added'),
    'client-side hunk',
  );
  results.push('PASS mixed Code / review rendering and client-side hunks');
  const exact = JSON.parse(await readBrowserSource(c, { ...input, base: input.head }));
  assert(exact.comparison.hunks.length === 0, 'exact State');
  results.push('PASS exact State');
  await control('corrupt=true');
  try {
    await readBrowserSource(client(), input);
    throw new Error('wrong content rendered');
  } catch (error) {
    assert((error as { code?: string }).code === 'BLOB_DIGEST_MISMATCH', 'checksum mismatch');
  }
  results.push('PASS checksum error prevents render');
  await control('expired=1');
  const before = await fetch(`${service}/stats`).then(response => response.json());
  await readBrowserSource(client(), input);
  const after = await fetch(`${service}/stats`).then(response => response.json());
  assert(after.signing > before.signing, 'expired signed URL refresh');
  results.push('PASS expired URL refresh');
  await control('revoked=true');
  try {
    await readBrowserSource(c, input);
    throw new Error('revoked read succeeded');
  } catch (error) {
    assert((error as { code?: string }).code === 'PROJECT_UNAVAILABLE', 'revoked member');
  }
  results.push('PASS revoked read denied despite cache');
  await control();
  const reader = new ObjectDownloadReader({
    describe: async () => [{ digest: f.leaf.sha256, size: f.leaf.size, location: 'r2' }],
    sign: async () => [
      { digest: f.leaf.sha256, size: f.leaf.size, url: `${service}/object/${f.leaf.sha256}` },
    ],
  });
  const leaf = await reader.tree(f.leaf, { ...f.leaf, height: 0, length: f.leaf.size });
  assert(new TextDecoder().decode(leaf).includes('ranged recipe'), 'ranged leaf');
  results.push('PASS ranged leaf verification');
  const archive = await downloadObjectArchive(client(), 'project' as never, 'backup' as never);
  assert(archive.blob.size > 0 && archive.digest.length === 64, 'archive download');
  results.push('PASS browser gzip archive');
  const idleStart = await fetch(`${service}/stats`).then(response => response.json());
  await new Promise(resolve => setTimeout(resolve, 1200));
  const idleEnd = await fetch(`${service}/stats`).then(response => response.json());
  assert(idleStart.calls.length === idleEnd.calls.length, 'idle calls');
  results.push('PASS idle makes zero calls');
}
run()
  .then(() => {
    document.querySelector('#results')!.textContent =
      `${results.length}/${results.length} checks passed\n${results.join('\n')}`;
    Object.assign(window, { __r2Results: { passed: results.length, results } });
  })
  .catch(error => {
    document.querySelector('#results')!.textContent = `FAILED: ${error.code ?? ''} ${error.message}`;
    Object.assign(window, { __r2Results: { passed: results.length, results, error: error.message } });
  });
