import { captureNativeArchive } from './native-archive-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initNative } from '../dist/native-work.js';
import { WorkService } from '../dist/work.js';
import { WorkStore } from '../dist/work-store.js';
import { NativeSource } from '../dist/native-source.js';
import { pullNativeExchange } from '../dist/native-exchange.js';
import { digest } from '../dist/hash.js';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-exchange-test-')),
    root = join(dir, 'owner');
  mkdirSync(root);
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'source.ts'), 'export const value = 1;\n');
  writeFileSync(join(root, 'large.bin'), Buffer.alloc(256 * 1024, 25));
  initNative(root);
  const w = new WorkService(root),
    act = c => w.execute(c, w.status().revision).result;
  const intent = act({ action: 'intent', outcome: 'Exchange one edit' }),
    lane = act({ action: 'lane', intentId: intent.id, name: 'Change' });
  const objects = new Map(),
    snapshots = new Map();
  let uploads = 0;
  const transport = {
    missing: async pins => pins.filter(p => !objects.has(p.sha256)).map(p => p.sha256),
    upload: async (pin, bytes) => {
      assert.equal(digest(bytes), pin.sha256);
      assert.equal(bytes.length, pin.size);
      objects.set(pin.sha256, Buffer.from(bytes));
      uploads++;
    },
    publish: async pin => {
      snapshots.set(pin.sha256, pin);
      return pin.sha256;
    },
    manifest: async id => ({ json: objects.get(id).toString(), digest: id, size: snapshots.get(id).size }),
    download: async pin => Buffer.from(objects.get(pin.sha256)),
  };
  return { dir, root, w, act, intent, lane, objects, transport, uploads: () => uploads };
}

test('optional agent exchange tools disclose migration semantics and require account-token configuration', async t => {
  const { registerExchangeTools } = await import('../dist/mcp-exchange.js'),
    saved = process.env.FORGE_AUTH_TOKEN,
    savedConfig = process.env.XDG_CONFIG_HOME,
    config = mkdtempSync(join(tmpdir(), 'forge-exchange-auth-')),
    tools = [];
  t.after(() => rmSync(config, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  try {
    delete process.env.FORGE_AUTH_TOKEN;
    process.env.XDG_CONFIG_HOME = config;
    registerExchangeTools({ registerTool: (...args) => tools.push(args) }, '/unused');
    assert.equal(tools.length, 0);
    process.env.FORGE_AUTH_TOKEN = 'test-only';
    registerExchangeTools({ registerTool: (...args) => tools.push(args) }, '/unused');
    assert.deepEqual(
      tools.map(item => item[0]),
      ['forge_exchange', 'forge_migrate_archive'],
    );
    assert.equal(tools[1][1].annotations.destructiveHint, true);
    assert.match(tools[1][1].description, /compressed-container bytes/);
    assert.equal(
      tools[0][1].inputSchema.command.safeParse({ action: 'push', url: 'bad', projectId: 'x' }).success,
      false,
    );
  } finally {
    if (saved === undefined) delete process.env.FORGE_AUTH_TOKEN;
    else process.env.FORGE_AUTH_TOKEN = saved;
    if (savedConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedConfig;
  }
});
test('logical archive validation preserves original bytes and cleans scratch on failure without materializing Lanes', async t => {
  const { exportNativeWork } = await import('../dist/native-backup.js'),
    { withValidatedNativeArchive } = await import('../dist/native-archive-validation.js'),
    f = fixture(t);
  const exported = await exportNativeWork(f.w.store, f.w.status().revision, false),
    directory = exported.result.path,
    manifestBytes = readFileSync(join(directory, 'manifest.json')),
    workBytes = readFileSync(join(directory, 'work.json'));
  await assert.rejects(
    withValidatedNativeArchive(directory, async validated => {
      assert.equal(
        readdirSync(validated.directory).some(name => name.startsWith('lane-')),
        false,
      );
      assert.deepEqual(readFileSync(join(validated.directory, 'work.json')), workBytes);
      throw new Error('stop after validation');
    }),
    /stop after validation/,
  );
  assert.deepEqual(readFileSync(join(directory, 'manifest.json')), manifestBytes);
  assert.deepEqual(readFileSync(join(directory, 'work.json')), workBytes);
  const manifest = JSON.parse(manifestBytes),
    blob = new NativeSource(f.root).state(f.w.store.load().nativeHead).files[0].blob;
  manifest.files = manifest.files.filter(file => file.path !== `objects/${blob}`);
  rmSync(join(directory, 'objects', blob));
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(
    withValidatedNativeArchive(directory, async () => assert.fail('Invalid closure reached transfer')),
    error => error.code === 'INVALID_NATIVE_SOURCE',
  );
  assert.ok(readdirSync(directory).includes('work.json'));
});

test('local derivation retains oversized Views, bounds its cache and ignores oversized legacy caches', async t => {
  const { OWNER_DERIVED_MAX_BYTES } = await import('../dist/owner-derived.js');
  const { ownerDerivedBytes } = await import('../dist/owner-derived-local.js');
  const { statSync } = await import('node:fs');
  const f = fixture(t),
    data = f.w.store.load();
  const cache = join(f.w.store.directory, 'owner-derived-cache.json');
  writeFileSync(cache, Buffer.alloc(OWNER_DERIVED_MAX_BYTES + 1, 32));
  assert.ok(ownerDerivedBytes(f.w.store, data));
  assert.ok(statSync(cache).size <= OWNER_DERIVED_MAX_BYTES);
  const lane = data.lanes[0];
  data.intents[0].outcome = 'Synthetic '.repeat(OWNER_DERIVED_MAX_BYTES / 5);
  data.views.push({
    id: 'large',
    intentId: lane.intentId,
    base: lane.base,
    head: lane.head,
    inputs: [{ laneId: lane.id, head: lane.head }],
    status: 'clean',
    at: 'a',
  });
  const partial = JSON.parse(ownerDerivedBytes(f.w.store, data));
  assert.ok(partial.parents.length > 0, 'oversized View retains usable State facts');
  assert.equal(partial.views.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(partial)) > OWNER_DERIVED_MAX_BYTES);
  assert.ok(statSync(cache).size <= OWNER_DERIVED_MAX_BYTES);
});
