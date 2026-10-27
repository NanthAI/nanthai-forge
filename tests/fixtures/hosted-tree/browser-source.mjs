// SPDX-License-Identifier: Apache-2.0
// Digest-pinned synthetic source for browser component fixtures. No server text shortcut.
import { sha256Hex } from '../../../web/src/verified-blob';
export async function browserSource(states, onGet = () => {}) {
  const objects = new Map(), heads = {}, encoder = new TextEncoder();
  const put = async (text, detail) => {
    const bytes = encoder.encode(text), pin = { sha256: await sha256Hex(bytes), size: bytes.length };
    if (!objects.has(pin.sha256)) objects.set(pin.sha256, { pin, detail,
      url: `data:application/octet-stream;base64,${btoa(String.fromCharCode(...bytes))}` });
    return pin;
  };
  for (const [name, files] of Object.entries(states)) {
    const entries = [];
    for (const [path, text] of Object.entries(files)) {
      const blob = await put(text, { kind: 'file', file: path });
      entries.push({ path, blob: blob.sha256, mode: 'file' });
    }
    const state = await put(JSON.stringify({ kind: 'forge-source-state', schema: 1, parents: [],
      files: entries, message: name, at: '2026-01-01T00:00:00.000Z' }), { kind: 'state' });
    heads[name] = state.sha256;
  }
  const work = await put('{}', { kind: 'work' });
  const root = await put(JSON.stringify({ kind: 'forge-native-work-backup', schema: 1,
    id: '00000000-0000-4000-8000-000000000000', head: Object.values(heads)[0], revision: 0,
    coverage: 'Synthetic browser fixture', unavailable: [], files: [{ path: 'work.json', ...work },
      ...[...objects.values()].filter(value => value.pin.sha256 !== work.sha256)
        .map(({ pin }) => ({ path: `objects/${pin.sha256}`, ...pin }))] }), { kind: 'manifest' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const object = [...objects.values()].find(object => object.url === url);
    if (object) onGet(object.detail);
    return originalFetch(input, init);
  };
  return { heads, mutations: {
    'projectObjectDownloads:source': args => JSON.stringify({
      backupId: args.backupId, backupDigest: root.sha256, manifestDigest: root.sha256,
      operationId: 'synthetic', transport: 'objects', format: 'native', root,
      pins: (args.digests ?? []).map(id => objects.get(id)?.pin).every(Boolean)
        ? (args.digests ?? []).map(id => objects.get(id).pin) : null,
    }),
    'projectObjectDownloads:describe': args => args.digests.map(digest => {
      const object = objects.get(digest);
      if (!object) throw new Error('Synthetic source is not retained.');
      return { digest, size: object.pin.size, location: 'convex', url: object.url };
    }),
    'projectObjectDownloads:signDownloads': () => [],
  } };
}
