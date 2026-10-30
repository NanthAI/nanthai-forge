// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  symlinkSync,
  chmodSync,
  lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { initNative, nativeExecute, nativeStatus } from '../dist/native-work.js';
import { NativeSource } from '../dist/native-source.js';
import { WorkStore } from '../dist/work-store.js';
import { refreshOwnerRoot, ownerRootNotice } from '../dist/owner-root.js';
import { syncTestHooks } from '../dist/native-sync-workspace.js';
import { policyPreset, editedPolicy } from '../dist/autonomy-policy.js';
const at = () => new Date().toISOString();
function fixture(t, enabled = true) {
  const root = mkdtempSync(join(tmpdir(), 'forge-owner-root-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'a.txt'), 'base a');
  writeFileSync(join(root, 'b.txt'), 'base b');
  writeFileSync(join(root, '.gitignore'), 'ignored/\n');
  const { head: base } = initNative(root),
    store = new WorkStore(root),
    source = new NativeSource(root);
  store.locked(() => {
    const data = store.load();
    data.autonomyPolicy.ownerRootUpdates = enabled;
    store.save(data);
  });
  const intentId = randomUUID();
  store.locked(() => {
    const data = store.load();
    data.intents.push({
      id: intentId,
      outcome: 'Owner root fixture',
      constraints: '',
      base,
      status: 'active',
      createdAt: at(),
      notes: [],
      dependencies: [],
    });
    store.save(data);
  });
  function candidate(edits, parent = base) {
    const files = new Map(source.state(parent).files.map(file => [file.path, file]));
    for (const [path, text] of Object.entries(edits)) {
      if (text === null) files.delete(path);
      else files.set(path, { path, blob: source.put(Buffer.from(text)), mode: 'file' });
    }
    const head = Object.keys(edits).length
      ? source.writeState([...files.values()], [parent], 'Candidate', at())
      : parent;
    const viewId = randomUUID();
    store.locked(() => {
      const data = store.load();
      data.views.push({
        id: viewId,
        intentId,
        base: parent,
        head,
        inputs: [],
        dependencies: [],
        status: 'clean',
        details: '',
        at: at(),
      });
      data.revision++;
      store.save(data);
    });
    return {
      action: 'accept-channel',
      operationId: randomUUID(),
      channel: 'main',
      viewId,
      expectedHead: head,
      expectedPrevious: parent === base && !store.load().channelMoves.length ? null : parent,
    };
  }
  const accept = command => nativeExecute(store, command, store.revision());
  accept(candidate({}));
  return { root, store, source, base, candidate, accept };
}
test('opt-in policy is off in every preset, reversible, and retains old policies', () => {
  for (const preset of ['supervised', 'trusted', 'autonomous'])
    assert.equal(policyPreset(preset).ownerRootUpdates, false);
  const before = policyPreset('trusted');
  const enabled = editedPolicy(before, {
    action: 'set-policy',
    operationId: randomUUID(),
    ownerRootUpdates: true,
  });
  assert.equal(enabled.ownerRootUpdates, true);
  assert.equal(enabled.preset, 'custom');
  assert.equal(
    editedPolicy(enabled, { action: 'set-policy', operationId: randomUUID(), ownerRootUpdates: false })
      .ownerRootUpdates,
    false,
  );
});
test('clean acceptance refreshes tracked additions and removals; metadata and local extras survive', t => {
  const f = fixture(t);
  const marker = readFileSync(join(f.root, '.forge/native.json'));
  writeFileSync(join(f.root, '.forge/sentinel'), 'metadata');
  writeFileSync(join(f.root, 'untracked.txt'), 'local');
  mkdirSync(join(f.root, 'ignored'));
  writeFileSync(join(f.root, 'ignored/local'), 'ignored');
  const command = f.candidate({ 'a.txt': 'accepted', 'b.txt': null, 'new.txt': 'new' });
  const result = f.accept(command);
  assert.equal(result.ownerRoot.status, 'updated');
  assert.equal(readFileSync(join(f.root, 'a.txt'), 'utf8'), 'accepted');
  assert.equal(existsSync(join(f.root, 'b.txt')), false);
  assert.equal(readFileSync(join(f.root, 'new.txt'), 'utf8'), 'new');
  assert.deepEqual(readFileSync(join(f.root, '.forge/native.json')), marker);
  for (const [path, text] of [
    ['.forge/sentinel', 'metadata'],
    ['untracked.txt', 'local'],
    ['ignored/local', 'ignored'],
  ])
    assert.equal(readFileSync(join(f.root, path), 'utf8'), text);
});
test('default-off acceptance leaves root alone; explicit CLI refresh catches up safely', t => {
  const f = fixture(t, false);
  const first = f.candidate({ 'a.txt': 'first' });
  f.accept(first);
  f.accept(f.candidate({ 'a.txt': 'new' }, first.expectedHead));
  assert.equal(readFileSync(join(f.root, 'a.txt'), 'utf8'), 'base a');
  const receipt = JSON.parse(
    execFileSync(process.execPath, ['dist/cli.js', 'owner', 'refresh', f.root], { encoding: 'utf8' }),
  );
  assert.equal(receipt.status, 'updated');
  assert.equal(readFileSync(join(f.root, 'a.txt'), 'utf8'), 'new');
});
test('dirty root is skipped after durable acceptance, reported, and recoverable without losing edits', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'b.txt'), 'local edit');
  const command = f.candidate({ 'a.txt': 'accepted' });
  const result = f.accept(command);
  assert.equal(result.result.status, 'accepted');
  assert.equal(result.ownerRoot.status, 'skipped');
  assert.equal(readFileSync(join(f.root, 'a.txt'), 'utf8'), 'base a');
  assert.equal(readFileSync(join(f.root, 'b.txt'), 'utf8'), 'local edit');
  const notice = nativeStatus(f.store, f.store.load(), { compact: true }).ownerRoot;
  assert.equal(notice.status, 'skipped');
  assert.equal(notice.recovery, `nforge owner refresh '${f.store.root}'`);
  assert.throws(() => refreshOwnerRoot(f.store), { code: 'OWNER_ROOT_REFRESH_SKIPPED' });
  writeFileSync(join(f.root, 'b.txt'), 'base b');
  refreshOwnerRoot(f.store);
  assert.equal(readFileSync(join(f.root, 'a.txt'), 'utf8'), 'accepted');
  assert.equal(ownerRootNotice(f.store).status, 'updated');
});
for (const collision of ['different', 'same', 'ignored', 'symlink', 'directory'])
  test(`new tracked path preserves ${collision} untracked collision`, t => {
    const f = fixture(t);
    let path = 'new.txt';
    if (collision === 'ignored') {
      mkdirSync(join(f.root, 'ignored'));
      path = 'ignored/new.txt';
    }
    if (collision === 'symlink') symlinkSync(join(f.root, 'a.txt'), join(f.root, path));
    else if (collision === 'directory') mkdirSync(join(f.root, path));
    else writeFileSync(join(f.root, path), collision === 'same' ? 'accepted' : 'local');
    const result = f.accept(f.candidate({ [path]: 'accepted' }));
    assert.equal(result.ownerRoot.status, 'skipped');
    if (!['symlink', 'directory'].includes(collision))
      assert.equal(readFileSync(join(f.root, path), 'utf8'), collision === 'same' ? 'accepted' : 'local');
  });
test('an edit equal to the target is still dirty before a refresh starts', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'a.txt'), 'new');
  const result = f.accept(f.candidate({ 'a.txt': 'new', 'b.txt': 'also new' }));
  assert.equal(result.ownerRoot.status, 'skipped');
  assert.equal(readFileSync(join(f.root, 'b.txt'), 'utf8'), 'base b');
});
for (const hook of ['afterPlan', 'afterReplace', 'afterRemove', 'duringWrite', 'afterWorkspace'])
  test(`interruption at ${hook} resumes pinned update and advances to newest main`, t => {
    const f = fixture(t);
    const first = f.candidate({ 'a.txt': 'first', 'b.txt': null, 'new.txt': 'new' });
    let called = false;
    syncTestHooks[hook] = () => {
      if (!called) {
        called = true;
        throw new Error('injected interruption');
      }
    };
    t.after(() => {
      delete syncTestHooks[hook];
    });
    assert.equal(f.accept(first).ownerRoot.status, 'skipped');
    delete syncTestHooks[hook];
    const second = f.candidate({ 'a.txt': 'latest' }, first.expectedHead);
    assert.equal(f.accept(second).ownerRoot.status, 'updated');
    // Replaying an older acceptance updates from current main, never its old pins.
    assert.equal(f.accept(first).ownerRoot.head, second.expectedHead);
    assert.equal(readFileSync(join(f.root, 'a.txt'), 'utf8'), 'latest');
    assert.equal(existsSync(join(f.root, 'b.txt')), false);
    assert.equal(readFileSync(join(f.root, 'new.txt'), 'utf8'), 'new');
  });
test('pending refresh refuses a later unrelated root edit', t => {
  const f = fixture(t);
  syncTestHooks.afterReplace = () => {
    throw new Error('interrupted');
  };
  t.after(() => {
    delete syncTestHooks.afterReplace;
  });
  f.accept(f.candidate({ 'a.txt': 'new', 'b.txt': 'new b' }));
  delete syncTestHooks.afterReplace;
  writeFileSync(join(f.root, 'b.txt'), 'local edit');
  assert.throws(() => refreshOwnerRoot(f.store), { code: 'OWNER_ROOT_REFRESH_SKIPPED' });
  assert.equal(readFileSync(join(f.root, 'b.txt'), 'utf8'), 'local edit');
});
test('concurrent disjoint owner acceptances serialize root at newest main', async t => {
  const f = fixture(t);
  const commands = [f.candidate({ 'a.txt': 'accepted a' }), f.candidate({ 'b.txt': 'accepted b' })];
  const run = command =>
    new Promise((resolve, reject) => {
      const script = `import { WorkStore } from './dist/work-store.js';
      import { nativeExecute } from './dist/native-work.js';
      const store = new WorkStore(${JSON.stringify(f.root)}), command = ${JSON.stringify(command)};
      // A retired relay bypass used to compose inside acceptance. Native callers
      // now compose explicitly after a CAS race, retaining both accepted deltas.
      const { NativeSource } = await import('./dist/native-source.js');
      const source = new NativeSource(store.root);
      let composed = command;
      for (;;) {
        try { nativeExecute(store, composed, store.locked(() => store.revision())); console.log(JSON.stringify(composed)); break; }
        catch (e) {
          if (e.code === 'WORK_STALE') continue;
          if (e.code !== 'CHANNEL_CHANGED') throw e;
          composed = store.locked(() => {
            const data = store.load(), previous = data.channelMoves.at(-1).head;
            const merged = source.compose(previous, command.expectedHead, 'Retry owner acceptance', new Date().toISOString());
            if (!merged.head || merged.conflicts.length) throw new Error('Unexpected compose conflict');
            const viewId = crypto.randomUUID(), view = data.views.find(view => view.id === command.viewId);
            data.views.push({ ...view, id: viewId, head: merged.head, base: previous });
            data.revision++;
            store.save(data);
            return { ...command, operationId: crypto.randomUUID(), viewId, expectedHead: merged.head, expectedPrevious: previous };
          });
        }
      }`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...process.env, FORGE_WORK_LOCK_WAIT_MS: '60000' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let errors = '',
        output = '';
      child.stdout.on('data', bytes => {
        output += bytes;
      });
      child.stderr.on('data', bytes => {
        errors += bytes;
      });
      child.on('error', reject);
      child.on('exit', code => (code === 0 ? resolve(JSON.parse(output)) : reject(new Error(errors))));
    });
  const results = await Promise.allSettled(commands.map(run));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  const main = f.store.load().channelMoves.at(-1).head;
  assert.equal(ownerRootNotice(f.store).head, main);
  assert.equal(readFileSync(join(f.root, 'a.txt'), 'utf8'), 'accepted a');
  assert.equal(readFileSync(join(f.root, 'b.txt'), 'utf8'), 'accepted b');
  f.accept(results[0].value);
  assert.equal(ownerRootNotice(f.store).head, main);
});

test('process exit mid-replacement leaves a durable plan that explicit refresh resumes', t => {
  const f = fixture(t);
  const command = f.candidate({ 'a.txt': 'after crash', 'b.txt': 'also after crash' });
  const script = `import { WorkStore } from './dist/work-store.js';
    import { nativeExecute } from './dist/native-work.js';
    import { syncTestHooks } from './dist/native-sync-workspace.js';
    syncTestHooks.afterReplace = () => process.exit(73);
    const store = new WorkStore(${JSON.stringify(f.root)});
    nativeExecute(store, ${JSON.stringify(command)}, store.revision());`;
  assert.throws(
    () => execFileSync(process.execPath, ['--input-type=module', '-e', script]),
    error => error.status === 73,
  );
  assert.equal(f.store.load().channelMoves.at(-1).head, command.expectedHead);
  assert.equal(refreshOwnerRoot(f.store).status, 'updated');
  assert.equal(readFileSync(join(f.root, 'a.txt'), 'utf8'), 'after crash');
  assert.equal(readFileSync(join(f.root, 'b.txt'), 'utf8'), 'also after crash');
});

for (const interrupted of [false, true])
  test(`file/directory transitions preserve root source${interrupted ? ' across interruption' : ''}`, t => {
    const f = fixture(t);
    const first = f.candidate({ 'a.txt': null, 'a.txt/child': 'nested' });
    if (interrupted) {
      syncTestHooks.afterReplace = () => {
        throw new Error('interrupted transition');
      };
      t.after(() => {
        delete syncTestHooks.afterReplace;
      });
      assert.equal(f.accept(first).ownerRoot.status, 'skipped');
      delete syncTestHooks.afterReplace;
      assert.equal(refreshOwnerRoot(f.store).status, 'updated');
    } else assert.equal(f.accept(first).ownerRoot.status, 'updated');
    assert.equal(readFileSync(join(f.root, 'a.txt/child'), 'utf8'), 'nested');
    const second = f.candidate({ 'a.txt/child': null, 'a.txt': 'flat' }, first.expectedHead);
    assert.equal(f.accept(second).ownerRoot.status, 'updated');
    assert.equal(readFileSync(join(f.root, 'a.txt'), 'utf8'), 'flat');
  });

test('refresh applies accepted executable mode and refuses a local mode edit', t => {
  const f = fixture(t);
  const command = f.candidate({ 'a.txt': 'base a' });
  const files = f.source
    .state(command.expectedHead)
    .files.map(file => (file.path === 'a.txt' ? { ...file, mode: 'executable' } : file));
  command.expectedHead = f.source.writeState(files, [f.base], 'Executable mode', at());
  f.store.locked(() => {
    const data = f.store.load();
    data.views.find(view => view.id === command.viewId).head = command.expectedHead;
    f.store.save(data);
  });
  assert.equal(f.accept(command).ownerRoot.status, 'updated');
  assert.ok(lstatSync(join(f.root, 'a.txt')).mode & 0o111);
  chmodSync(join(f.root, 'b.txt'), 0o700);
  const next = f.candidate({ 'a.txt': 'another' }, command.expectedHead);
  assert.equal(f.accept(next).ownerRoot.status, 'skipped');
  assert.equal(readFileSync(join(f.root, 'a.txt'), 'utf8'), 'base a');
  assert.ok(lstatSync(join(f.root, 'b.txt')).mode & 0o111);
});
