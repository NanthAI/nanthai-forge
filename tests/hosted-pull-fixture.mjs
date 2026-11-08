// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from '../dist/hash.js';
import { ForgeError } from '../dist/errors.js';
import { clientCacheRoot } from '../dist/root-paths.js';
/** `extra` adds tracked [path, text] files to the first main, such as an ignore file. */
export function pullFixture(t, count = 3, extra = []) {
  const directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'forge-pull-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const root = join(directory, 'clone'),
    address = { projectId: 'project', url: 'https://fixture.invalid' };
  const objects = new Map(),
    add = bytes => {
      bytes = Buffer.from(bytes);
      const id = digest(bytes);
      objects.set(id, bytes);
      return id;
    };
  let files = Array.from({ length: count }, (_, i) => ({
    path: `src/${i}.txt`,
    blob: add(`source ${i}\n`),
    mode: 'file',
  }));
  files.push(...extra.map(([path, text]) => ({ path, blob: add(text), mode: 'file' })));
  let state,
    main,
    allowed = true,
    failDownload = false,
    onCurrent = () => {};
  const calls = { queries: 0, pages: [], gets: [], bytes: 0, pack: 0 };
  const select = changes => {
    const old = main;
    for (const [path, bytes, mode = 'file'] of changes) {
      files = files.filter(file => file.path !== path);
      if (bytes !== null) files.push({ path, blob: add(bytes), mode });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    state = {
      schema: 1,
      kind: 'forge-source-state',
      parents: old ? [old.head] : [],
      files,
      message: 'synthetic',
      at: '2026-01-01T00:00:00Z',
    };
    main = {
      schema: 2,
      ...address,
      snapshotId: randomUUID(),
      sourceRevision: old ? old.sourceRevision + 1 : 0,
      authority: { mode: 'server', epoch: 1 },
      channel: 'main',
      head: add(JSON.stringify(state)),
      receipt: {
        id: randomUUID(),
        kind: 'server',
        previousHead: old?.head ?? null,
        previousReceiptId: old?.receipt.id ?? null,
      },
    };
    delete main.url;
  };
  select([]);
  fs.mkdirSync(join(root, 'src'), { recursive: true });
  fs.mkdirSync(join(root, '.forge'));
  fs.writeFileSync(join(root, '.forge/hosted-main.json'), JSON.stringify({ selection: main, state }));
  for (const file of files) fs.writeFileSync(join(root, file.path), objects.get(file.blob));
  // Seed only the old manifest. Unchanged files must come from ROOT, even with
  // a completely cold machine cache and per-clone blob store.
  fs.mkdirSync(join(clientCacheRoot(root), 'objects'), { recursive: true });
  fs.writeFileSync(join(clientCacheRoot(root), 'objects', main.head), objects.get(main.head));
  const transport = {
    current: async () => {
      calls.queries++;
      onCurrent();
      if (!allowed) throw new ForgeError('PROJECT_UNAVAILABLE', 'revoked');
      return structuredClone(main);
    },
    objects: async ids => {
      calls.pages.push(ids);
      return ids.map(sha256 => ({ sha256, size: objects.get(sha256).length }));
    },
    downloadToFile: async (pin, path) => {
      if (failDownload) throw Error('interrupted transfer');
      calls.gets.push(pin.sha256);
      calls.bytes += pin.size;
      fs.writeFileSync(path, objects.get(pin.sha256), { mode: 0o600 });
    },
    sourcePack: async () => {
      calls.pack++;
      throw Error('pull must never fetch a source pack');
    },
  };
  return {
    root,
    directory,
    address,
    objects,
    transport,
    calls,
    select,
    main: () => structuredClone(main),
    state: () => structuredClone(state),
    access: value => {
      allowed = value;
    },
    fail: value => {
      failDownload = value;
    },
    onCurrent: callback => {
      onCurrent = callback;
    },
    reset: () => {
      calls.queries = 0;
      calls.pages = [];
      calls.gets = [];
      calls.bytes = 0;
      calls.pack = 0;
    },
  };
}
