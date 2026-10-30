import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initNative } from '../dist/native-work.js';
import { WorkService } from '../dist/work.js';
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-revision-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const root = join(dir, 'owner');
  mkdirSync(root);
  writeFileSync(join(root, 'source.ts'), 'export const value=1;');
  initNative(root);
  return { root, work: new WorkService(root) };
}
test('revision observation reads only the record manifest and remains available without collection objects', t => {
  const { work } = setup(t);
  work.execute({ action: 'intent', outcome: 'Retained source work' }, work.status().revision);
  const revision = work.store.load().revision;
  assert.equal(work.store.revision(), revision);
  const manifest = JSON.parse(readFileSync(join(work.store.directory, 'work.json'), 'utf8'));
  assert.equal(manifest.schema, 'forge-work-records-v3');
  rmSync(join(work.store.directory, 'records'), { recursive: true, force: true });
  assert.equal(work.store.revision(), revision);
  assert.throws(() => work.store.load());
  manifest.fields.revision = 'invalid';
  writeFileSync(join(work.store.directory, 'work.json'), JSON.stringify(manifest));
  assert.throws(() => work.store.revision(), { code: 'INVALID_WORK_STORE' });
});
test('old-format revision is rejected without changing bytes', t => {
  const { work } = setup(t),
    data = work.store.load();
  delete data.autonomyPolicy;
  data.schema = 1;
  data.revision = 9;
  const bytes = JSON.stringify(data),
    path = join(work.store.directory, 'work.json');
  writeFileSync(path, bytes);
  assert.throws(() => work.store.revision(), { code: 'WORK_UPGRADE_REQUIRED' });
  assert.equal(readFileSync(path, 'utf8'), bytes);
});
