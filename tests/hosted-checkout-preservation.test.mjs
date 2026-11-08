// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readlinkSync,
  lstatSync,
  existsSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fixture } from './hosted-sync-client-fixture.mjs';
import { applyHostedSync } from '../dist/hosted-sync-client.js';
import { cleanHostedCheckout } from '../dist/hosted-checkout-files.js';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';
import { clientCacheRoot } from '../dist/root-paths.js';

const rules = [
  // Build output is preserved because the project ignores it, as in Git; Forge never drops a folder by name.
  { path: '.gitignore', content: '/out/\n/dist/\n/convex/_generated/\n' },
  { path: '.forgeignore', content: '/custom-cache/\n' },
];
// A file turning into a directory keeps the full private-stage install; ordinary edits apply in place.
function fullStageCommand(s) {
  s.setFiles([
    { ...s.files[0], blob: s.put('after\n') },
    { path: 'unaffected/inner', blob: s.put('unchanged'), mode: 'file' },
    ...s.files.slice(2),
  ]);
  return s.command();
}
function outputs(s) {
  const files = [
    'dist/accounting-records.d.ts',
    'convex/_generated/api.d.ts',
    'out/deep/object',
    'custom-cache/blob',
  ];
  for (const path of files) {
    mkdirSync(join(s.root, path, '..'), { recursive: true });
    writeFileSync(join(s.root, path), `synthetic ${path}`);
  }
  symlinkSync('../shared-dependencies', join(s.root, 'node_modules'));
  mkdirSync(join(s.root, '../shared-dependencies'));
  writeFileSync(join(s.root, '../shared-dependencies/package'), 'shared untouched');
  return () => {
    for (const path of files) assert.equal(readFileSync(join(s.root, path), 'utf8'), `synthetic ${path}`);
    assert.equal(readlinkSync(join(s.root, 'node_modules')), '../shared-dependencies');
    assert.equal(readFileSync(join(s.root, '../shared-dependencies/package'), 'utf8'), 'shared untouched');
  };
}

test('sync onto changed source preserves build outputs, generated API, declared caches and dependency links', async t => {
  const s = await fixture(t, undefined, rules),
    check = outputs(s),
    request = s.command();
  const inodes = ['dist', 'node_modules', 'out'].map(path => lstatSync(join(s.root, path)).ino);
  const result = await applyHostedSync(s.root, request, s.transport);
  assert.equal(result.head, request.lane.head);
  check();
  assert.deepEqual(
    ['dist', 'node_modules', 'out'].map(path => lstatSync(join(s.root, path)).ino),
    inodes,
  );
  assert.equal(readFileSync(join(s.root, 'a'), 'utf8'), 'after\n');
  writeFileSync(join(s.root, 'a'), 'later unsaved edit');
  const replay = await applyHostedSync(s.root, request, s.transport);
  assert(replay.replayed);
  assert.equal(readFileSync(join(s.root, 'a'), 'utf8'), 'later unsaved edit');
  check();
});

const fullPhases = ['old-rename', 'new-rename', 'legacy-new-rename', 'artifact-rename', 'complete-receipt'];
const deltaPhases = ['delta-displace', 'delta-install', 'delta-marker', 'delta-complete-receipt'];
for (const phase of [...fullPhases, ...deltaPhases])
  test(`interrupted ${phase} resumes the original apply once with every artifact intact`, async t => {
    const s = await fixture(t, undefined, rules),
      check = outputs(s),
      delta = phase.startsWith('delta-'),
      request = delta ? s.command() : fullStageCommand(s);
    const rename = fs.renameSync;
    let interrupted = false,
      installations = 0;
    t.mock.method(fs, 'renameSync', (from, to) => {
      const result = rename(from, to);
      if (String(from).includes('/checkout-') && to === s.root) installations++;
      if (String(from).includes('/delta-') && to === join(s.root, 'a')) installations++;
      const match = delta
        ? phase === 'delta-displace'
          ? from === join(s.root, 'a')
          : phase === 'delta-install'
            ? String(from).includes('/delta-') && to === join(s.root, 'a')
            : phase === 'delta-marker'
              ? String(from).includes('/delta-') && String(to).startsWith(join(s.root, '.forge'))
              : to === join(clientCacheRoot(s.root), `${request.operationId}.json`) &&
                JSON.parse(readFileSync(to)).complete
        : phase === 'old-rename'
          ? from === s.root
          : ['new-rename', 'legacy-new-rename'].includes(phase)
            ? String(from).includes('/checkout-') && to === s.root
            : phase === 'artifact-rename'
              ? String(from).includes('/previous/') && to === join(s.root, 'dist')
              : to === join(clientCacheRoot(s.root), `${request.operationId}.json`) &&
                JSON.parse(readFileSync(to)).complete;
      if (!interrupted && match) {
        interrupted = true;
        throw Error('synthetic interrupted publication');
      }
      return result;
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(applyHostedSync(s.root, request, s.transport), /synthetic interrupted/);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert(interrupted);
    if (phase === 'legacy-new-rename')
      rmSync(join(clientCacheRoot(s.root), `preserve-${request.operationId}.json`));
    const result = await applyHostedSync(s.root, request, s.transport);
    assert.equal(result.head, request.lane.head);
    assert.equal(readHostedLaneCheckout(s.root).selection.head, request.lane.head);
    check();
    assert((await applyHostedSync(s.root, request, s.transport)).replayed);
    assert.equal(installations, ['old-rename', 'delta-displace'].includes(phase) ? 0 : 1);
    if (delta) {
      assert.equal(readFileSync(join(s.root, 'a'), 'utf8'), 'after\n');
      assert(!fs.readdirSync(clientCacheRoot(s.root)).some(name => name.startsWith('delta-')));
    }
  });

for (const path of ['out/new.ts', 'node_modules/new.ts', 'a'])
  test(`ignored or tracked incoming source ${path} cannot overwrite different local bytes or links`, async t => {
    const s = await fixture(t, undefined, rules),
      check = outputs(s);
    if (path === 'out/new.ts') writeFileSync(join(s.root, path), 'local draft');
    if (path === 'a') writeFileSync(join(s.root, path), 'unsaved tracked edit');
    s.setFiles([
      ...s.files.filter(file => file.path !== path),
      { path, blob: s.put('incoming source'), mode: 'file' },
    ]);
    const request = s.command();
    await assert.rejects(applyHostedSync(s.root, request, s.transport), error => {
      assert.equal(error.code, 'WORK_CONFLICT');
      assert.equal(error.recovery.sourceCompleted, true);
      assert.equal(error.recovery.blockers[0].path, path.startsWith('node_modules/') ? 'node_modules' : path);
      assert.equal(error.recovery.next.action, 'recover-apply');
      assert(error.recovery.command.includes(request.operationId));
      return true;
    });
    assert.equal(readHostedLaneCheckout(s.root).selection.head, s.from.head);
    check();
  });

test('target source with identical untracked bytes is installed while disjoint ignored siblings survive', async t => {
  const s = await fixture(t, undefined, rules),
    check = outputs(s);
  const file = { path: 'out/new.ts', blob: s.put('incoming source'), mode: 'file' };
  s.setFiles([...s.files, file]);
  writeFileSync(join(s.root, file.path), 'incoming source');
  await applyHostedSync(s.root, s.command(), s.transport);
  assert.equal(readFileSync(join(s.root, file.path), 'utf8'), 'incoming source');
  check();
});

test('nested ignore rules and negations preserve only ignored output, never a re-included local draft', async t => {
  const s = await fixture(t, undefined, [{ path: 'pkg/.gitignore', content: '*.cache\n!draft.cache\n' }]);
  // The sync brings its own pkg/draft.cache, so a local draft there is source it would replace.
  s.setFiles([
    { ...s.files[0], blob: s.put('after\n') },
    ...s.files.slice(1),
    { path: 'pkg/draft.cache', blob: s.put('incoming draft'), mode: 'file' },
  ]);
  writeFileSync(join(s.root, 'pkg/data.cache'), 'output');
  writeFileSync(join(s.root, 'pkg/draft.cache'), 'draft');
  await assert.rejects(applyHostedSync(s.root, s.command(), s.transport), error => {
    assert.equal(error.recovery.blockers[0].path, 'pkg/draft.cache');
    return true;
  });
  rmSync(join(s.root, 'pkg/draft.cache'));
  await applyHostedSync(s.root, s.command(), s.transport);
  assert.equal(readFileSync(join(s.root, 'pkg/data.cache'), 'utf8'), 'output');
  assert.equal(readFileSync(join(s.root, 'pkg/draft.cache'), 'utf8'), 'incoming draft');
});

test('relative ROOT shares the absolute sibling cache boundary and creates no in-checkout cache', async t => {
  const s = await fixture(t),
    request = s.command();
  const relative = (await import('node:path')).relative(process.cwd(), s.root);
  await applyHostedSync(relative, request, s.transport);
  assert.equal(clientCacheRoot(relative), clientCacheRoot(s.root));
  assert(!existsSync(join(s.root, '..forge-client')));
  assert(!existsSync(join(s.root, '.forge-client')));
});

test('ignored subtrees are pruned without stat or byte reads of their contents', async t => {
  const s = await fixture(t, undefined, rules),
    check = outputs(s);
  const lstat = fs.lstatSync,
    read = fs.readFileSync,
    touched = [];
  t.mock.method(fs, 'lstatSync', (path, ...args) => {
    touched.push(String(path));
    return lstat(path, ...args);
  });
  t.mock.method(fs, 'readFileSync', (path, ...args) => {
    touched.push(String(path));
    return read(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    cleanHostedCheckout(s.root, readHostedLaneCheckout(s.root).state.files, 'hosted-lane.json', true);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert(!touched.some(path => /\/(dist|out|custom-cache|node_modules)\//.test(path)));
  check();
});

for (const same of [false, true])
  test(`incoming untracked source outside ignores ${same ? 'matches and installs' : 'differs and stays protected'}`, async t => {
    const s = await fixture(t),
      path = 'new.ts';
    s.setFiles([...s.files, { path, blob: s.put('incoming'), mode: 'file' }]);
    writeFileSync(join(s.root, path), same ? 'incoming' : 'local draft');
    if (same) await applyHostedSync(s.root, s.command(), s.transport);
    else
      await assert.rejects(applyHostedSync(s.root, s.command(), s.transport), error => {
        assert.equal(error.recovery.blockers[0].path, path);
        assert.equal(error.recovery.blockers[0].expectedDigest, s.put('incoming'));
        assert.equal(error.recovery.blockers[0].observedDigest, s.put('local draft'));
        return true;
      });
    assert.equal(readFileSync(join(s.root, path), 'utf8'), same ? 'incoming' : 'local draft');
  });

test('incoming file replacing an ignored directory cannot discard its untracked descendants', async t => {
  const s = await fixture(t, undefined, rules),
    check = outputs(s);
  s.setFiles([...s.files, { path: 'out', blob: s.put('incoming file'), mode: 'file' }]);
  await assert.rejects(applyHostedSync(s.root, s.command(), s.transport), { code: 'WORK_CONFLICT' });
  check();
});

test('tracked source within an ignored directory is always checked and ignored siblings survive', async t => {
  const s = await fixture(t, undefined, [...rules, { path: 'out/tracked.ts', content: 'saved source' }]);
  // The sync changes the tracked file, so an unsaved edit there must be found, ignored or not.
  s.setFiles([
    { ...s.files[0], blob: s.put('after\n') },
    ...s.files.slice(1).filter(file => file.path !== 'out/tracked.ts'),
    { path: 'out/tracked.ts', blob: s.put('incoming source'), mode: 'file' },
  ]);
  const check = outputs(s),
    command = s.command();
  writeFileSync(join(s.root, 'out/tracked.ts'), 'unsaved source');
  await assert.rejects(applyHostedSync(s.root, command, s.transport), error => {
    assert.equal(error.recovery.blockers[0].path, 'out/tracked.ts');
    return true;
  });
  writeFileSync(join(s.root, 'out/tracked.ts'), 'saved source');
  await applyHostedSync(s.root, command, s.transport);
  assert.equal(readFileSync(join(s.root, 'out/tracked.ts'), 'utf8'), 'incoming source');
  check();
});

test('an artifact destination recreated after interruption never overwrites either dependency link', async t => {
  const s = await fixture(t, undefined, rules),
    check = outputs(s),
    request = fullStageCommand(s);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    const result = rename(from, to);
    if (String(from).includes('/checkout-') && to === s.root) throw Error('synthetic publication stop');
    return result;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(applyHostedSync(s.root, request, s.transport), /synthetic publication stop/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  symlinkSync('../new-local-dependencies', join(s.root, 'node_modules'));
  await assert.rejects(applyHostedSync(s.root, request, s.transport), error => {
    assert.equal(error.code, 'WORK_CONFLICT');
    assert.equal(error.recovery.blockers[0].path, 'node_modules');
    return true;
  });
  assert.equal(readlinkSync(join(s.root, 'node_modules')), '../new-local-dependencies');
  assert.equal(
    readlinkSync(join(clientCacheRoot(s.root), 'previous/node_modules')),
    '../shared-dependencies',
  );
  rmSync(join(s.root, 'node_modules')); // remove only this fixture's recreated obstruction
  await applyHostedSync(s.root, request, s.transport);
  check();
});

for (const same of [false, true])
  test(`a legacy-shaped cache intersecting incoming source ${same ? 'matches' : 'conflicts'} without quarantine`, async t => {
    const s = await fixture(t),
      bytes = 'local cache object',
      id = s.put(bytes);
    const path = `..forge-client/objects/${id}`;
    mkdirSync(join(s.root, '..forge-client/objects'), { recursive: true });
    writeFileSync(join(s.root, path), bytes);
    s.setFiles([...s.files, { path, blob: same ? id : s.put('incoming source'), mode: 'file' }]);
    if (same) {
      const result = await applyHostedSync(s.root, s.command(), s.transport);
      assert.equal(result.localRecovery, undefined);
    } else
      await assert.rejects(applyHostedSync(s.root, s.command(), s.transport), error => {
        assert.equal(error.code, 'WORK_CONFLICT');
        assert.equal(error.recovery.blockers[0].path, path);
        return true;
      });
    assert.equal(readFileSync(join(s.root, path), 'utf8'), bytes);
  });

test('accepted large ignore files introduce no new apply size limit', async t => {
  const s = await fixture(t, undefined, [
    { path: '.gitignore', content: `#${'x'.repeat(1024 * 1024)}\n/cache/\n` },
  ]);
  mkdirSync(join(s.root, 'cache'));
  writeFileSync(join(s.root, 'cache/output'), 'keep output');
  await applyHostedSync(s.root, s.command(), s.transport);
  assert.equal(readFileSync(join(s.root, 'cache/output'), 'utf8'), 'keep output');
});

test('ignored native artifact names need not satisfy portable source-name rules', async t => {
  const s = await fixture(t, undefined, [{ path: '.gitignore', content: '*.log\n' }]);
  const path = 'generated\ntrace.log';
  writeFileSync(join(s.root, path), 'native output');
  await applyHostedSync(s.root, s.command(), s.transport);
  assert.equal(readFileSync(join(s.root, path), 'utf8'), 'native output');
});
