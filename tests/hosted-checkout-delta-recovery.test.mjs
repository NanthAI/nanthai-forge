// SPDX-License-Identifier: Apache-2.0
// Interrupted in-place apply: every later command, not only the same sync, must find a checkout
// whose marker describes its bytes. Interruptions throw a code-less error inside the apply's own
// process, at one rename boundary of a multi-path journal.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fixture } from './hosted-sync-client-fixture.mjs';
import { applyHostedSync } from '../dist/hosted-sync-client.js';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';
import { captureHostedSave } from '../dist/hosted-save-capture.js';
import { hostedLaneDirty } from '../dist/hosted-lane-dirty.js';
import { recoverLocalApply } from '../dist/hosted-apply-recovery.js';
import { clientCacheRoot } from '../dist/root-paths.js';

const journal = root => join(clientCacheRoot(root), 'delta-apply.json');
const deltaDirectories = root => readdirSync(clientCacheRoot(root)).filter(name => name.startsWith('delta-'));
const interrupted = () => Object.assign(new Error('synthetic interruption'));
/** a, d/one.txt and d/two.txt change, new/n.txt arrives, gone/x.txt leaves; gone/ also holds
 * ignored output, so it is emptied but not removed. */
async function multiFile(t) {
  const s = await fixture(t, undefined, [
    { path: '.gitignore', content: '*.log\n' },
    { path: 'd/one.txt', content: 'one before\n' },
    { path: 'd/two.txt', content: 'two before\n' },
    { path: 'gone/x.txt', content: 'removed upstream\n' },
  ]);
  writeFileSync(join(s.root, 'gone/out.log'), 'ignored output');
  const files = readHostedLaneCheckout(s.root).state.files.filter(file => file.path !== 'gone/x.txt');
  const target = {
    a: 'after\n',
    'd/one.txt': 'one after\n',
    'd/two.txt': 'two after\n',
    'new/n.txt': 'arrived\n',
  };
  s.setFiles([
    ...files.map(file =>
      target[file.path] === undefined ? file : { ...file, blob: s.put(target[file.path]) },
    ),
    { path: 'new/n.txt', blob: s.put(target['new/n.txt']), mode: 'file' },
  ]);
  const request = s.command();
  return { s, request, target };
}
const inStage = path => /\/delta-[A-Za-z0-9]+\//.test(String(path)) && !String(path).includes('-displaced/');
/** Throw once, before the matching rename (or rm) runs. */
function interruptAt(t, match) {
  const rename = fs.renameSync,
    remove = fs.rmSync;
  let fired = false;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (!fired && match('rename', String(from), String(to))) {
      fired = true;
      throw interrupted();
    }
    return rename(from, to);
  });
  t.mock.method(fs, 'rmSync', (path, ...rest) => {
    if (!fired && match('rm', String(path))) {
      fired = true;
      throw interrupted();
    }
    return remove(path, ...rest);
  });
  syncBuiltinESMExports();
  return () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    return fired;
  };
}
async function interruptSync(t, s, request, match) {
  const restore = interruptAt(t, match);
  try {
    await assert.rejects(applyHostedSync(s.root, request, s.transport), /synthetic interruption/);
  } finally {
    assert(restore(), 'the interruption boundary was reached');
  }
}
function assertTarget(s, request, target, output = s.root) {
  assert.equal(readHostedLaneCheckout(s.root).selection.head, request.lane.head);
  for (const [path, content] of Object.entries(target))
    assert.equal(readFileSync(join(s.root, path), 'utf8'), content, path);
  assert.equal(existsSync(join(s.root, 'gone/x.txt')), false);
  assert.equal(readFileSync(join(output, 'gone/out.log'), 'utf8'), 'ignored output');
  assert.equal(existsSync(journal(s.root)), false);
}
const boundaries = {
  'a later move aside': (kind, from) => kind === 'rename' && from.endsWith('/client/d/one.txt'),
  'first install': (kind, from, to) => kind === 'rename' && inStage(from) && to.endsWith('/client/a'),
  'second install': (kind, from, to) =>
    kind === 'rename' && inStage(from) && to.endsWith('/client/d/one.txt'),
  'last install': (kind, from, to) => kind === 'rename' && inStage(from) && to.endsWith('/client/new/n.txt'),
  'marker publication': (kind, from, to) =>
    kind === 'rename' && inStage(from) && to.endsWith('/client/.forge/hosted-lane.json'),
  'journal removal': (kind, path) => kind === 'rm' && path.endsWith('/delta-apply.json'),
};

test('save, dirty check and every later command see a whole tree after an interrupted apply at any step', async t => {
  for (const [name, match] of Object.entries(boundaries)) {
    const { s, request, target } = await multiFile(t);
    await interruptSync(t, s, request, match);
    assert.equal(hostedLaneDirty(s.root), true, name);
    // A save after the crash finishes the apply first: no upstream byte becomes a local "edit"
    // and no moved-aside path becomes a deletion.
    const captured = await captureHostedSave(s.root, join(clientCacheRoot(s.root), 'saves', randomUUID()));
    assert.deepEqual(
      captured.changes.map(change => change.path),
      [],
      `${name}: ${JSON.stringify(captured.changes.map(c => c.path))}`,
    );
    assert.equal(captured.marker.selection.head, request.lane.head, name);
    assertTarget(s, request, target);
    assert.equal(hostedLaneDirty(s.root), false, name);
    assert.deepEqual(deltaDirectories(s.root), [], name);
  }
});

test('a missing stage rolls the half-applied tree back and the same sync then completes', async t => {
  const { s, request, target } = await multiFile(t);
  await interruptSync(t, s, request, boundaries['second install']);
  const stage = JSON.parse(readFileSync(journal(s.root), 'utf8')).stage;
  rmSync(join(clientCacheRoot(s.root), stage), { recursive: true });
  const result = await applyHostedSync(s.root, request, s.transport);
  assert.equal(result.head, request.lane.head);
  assertTarget(s, request, target);
  assert.deepEqual(deltaDirectories(s.root), []);
});

test('a marker rewritten after the crash is never replaced; recover-apply preserves and finishes', async t => {
  const { s, request, target } = await multiFile(t);
  await interruptSync(t, s, request, boundaries['marker publication']);
  // An older client's save receipt or rebase rewrote the marker over the half-applied tree.
  const markerPath = join(s.root, '.forge/hosted-lane.json');
  const rewritten = JSON.stringify(readHostedLaneCheckout(s.root), null, 1);
  writeFileSync(markerPath, rewritten);
  await assert.rejects(applyHostedSync(s.root, request, s.transport), error => {
    assert.equal(error.code, 'WORK_CONFLICT');
    assert.equal(error.recovery.blockers[0].kind, 'delta-apply-pending');
    return true;
  });
  assert.equal(readFileSync(markerPath, 'utf8'), rewritten, 'the newer marker is kept');
  assert(existsSync(journal(s.root)), 'the journal is kept for an explicit recovery');
  const recovered = await recoverLocalApply(s.root, request.operationId, s.transport);
  assert.equal(recovered.status, 'applied');
  // Recovery restores the verified baseline in place; ignored output was never touched.
  assertTarget(s, request, target);
  assert.equal(readFileSync(join(recovered.preservedAt, 'a'), 'utf8'), 'after\n');
  assert(
    (recovered.additionalPreservedAt ?? []).some(path => existsSync(join(path, 'gone/x.txt'))),
    'moved-aside bytes are kept beside the preserved checkout',
  );
  assert.deepEqual(deltaDirectories(s.root), []);
});

test('an edit made after a crash, before anything was installed, refuses and stays in place', async t => {
  const { s, request } = await multiFile(t);
  const marker = readFileSync(join(s.root, '.forge/hosted-lane.json'));
  await interruptSync(t, s, request, boundaries['a later move aside']);
  writeFileSync(join(s.root, 'd/one.txt'), 'edited after the crash\n');
  await assert.rejects(applyHostedSync(s.root, request, s.transport), { code: 'WORK_CONFLICT' });
  assert.equal(readFileSync(join(s.root, 'd/one.txt'), 'utf8'), 'edited after the crash\n');
  assert.equal(readFileSync(join(s.root, 'a'), 'utf8'), 'before\n', 'moved-aside bytes are restored');
  assert.equal(readFileSync(join(s.root, 'gone/x.txt'), 'utf8'), 'removed upstream\n');
  assert.deepEqual(readFileSync(join(s.root, '.forge/hosted-lane.json')), marker);
  assert.deepEqual(deltaDirectories(s.root), []);
});

test('an interrupted refusal resumes as a refusal, never as an install', async t => {
  const { s, request } = await multiFile(t);
  const rename = fs.renameSync;
  let raced = false,
    restores = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    from = String(from);
    if (!raced && from === join(s.root, 'd/one.txt')) {
      raced = true;
      writeFileSync(from, 'racing local edit\n');
    }
    if (from.includes('-displaced/') && String(to).startsWith(`${s.root}/`) && restores++ === 1)
      throw interrupted();
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(applyHostedSync(s.root, request, s.transport), /synthetic interruption/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  await assert.rejects(applyHostedSync(s.root, request, s.transport), { code: 'WORK_CONFLICT' });
  assert.equal(readFileSync(join(s.root, 'd/one.txt'), 'utf8'), 'racing local edit\n');
  assert.equal(readFileSync(join(s.root, 'a'), 'utf8'), 'before\n');
  assert.equal(readHostedLaneCheckout(s.root).selection.head, s.from.head);
  assert.deepEqual(deltaDirectories(s.root), []);
});

test('a file recreated at an incoming path after installing began is kept aside and reported', async t => {
  const { s, request, target } = await multiFile(t);
  await interruptSync(t, s, request, boundaries['second install']);
  mkdirSync(join(s.root, 'new'), { recursive: true });
  writeFileSync(join(s.root, 'new/n.txt'), 'my own draft\n');
  const result = await applyHostedSync(s.root, request, s.transport);
  assertTarget(s, request, target);
  assert.match(result.warning, /kept at/);
  const [kept] = result.displacedRecovery;
  const spares = readdirSync(join(kept, 'occupied'));
  assert.equal(readFileSync(join(kept, 'occupied', spares[0], 'new/n.txt'), 'utf8'), 'my own draft\n');
});

test('a case-only or normalization-only rename with new content installs the exact spelling', async t => {
  const nfc = 'café.txt',
    nfd = 'café.txt';
  const s = await fixture(t, undefined, [
    { path: 'README.md', content: 'old readme\n' },
    { path: nfc, content: 'old menu\n' },
  ]);
  const kept = readHostedLaneCheckout(s.root).state.files.filter(
    file => file.path !== 'README.md' && file.path !== nfc,
  );
  s.setFiles([
    ...kept,
    { path: 'readme.md', blob: s.put('new readme\n'), mode: 'file' },
    { path: nfd, blob: s.put('new menu\n'), mode: 'file' },
  ]);
  const request = s.command();
  const result = await applyHostedSync(s.root, request, s.transport);
  assert.equal(result.head, request.lane.head);
  const names = readdirSync(s.root);
  assert(names.includes('readme.md') && !names.includes('README.md'), names.join(','));
  assert.equal(readFileSync(join(s.root, 'readme.md'), 'utf8'), 'new readme\n');
  assert.equal(readFileSync(join(s.root, nfd), 'utf8'), 'new menu\n');
});

test('a parent replaced by a link after a crash is refused, never followed', async t => {
  const { s, request } = await multiFile(t);
  await interruptSync(t, s, request, boundaries['a later move aside']);
  const outside = join(dirname(s.root), 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'two.txt'), 'outside bytes');
  renameSync(join(s.root, 'd'), join(s.root, 'd-moved'));
  symlinkSync(outside, join(s.root, 'd'));
  const refused = await applyHostedSync(s.root, request, s.transport).then(
    () => null,
    error => error,
  );
  assert.deepEqual(readdirSync(outside), ['two.txt'], 'nothing is installed outside the checkout');
  assert.equal(readFileSync(join(outside, 'two.txt'), 'utf8'), 'outside bytes');
  assert.equal(refused?.code, 'WORK_CONFLICT');
  assert.deepEqual(refused.recovery.blockers[0], { kind: 'delta-apply-pending', path: 'd' });
  assert(existsSync(journal(s.root)));
});

test('a journal from a newer client asks for an upgrade instead of failing to parse', async t => {
  const s = await fixture(t);
  writeFileSync(journal(s.root), JSON.stringify({ schema: 4, future: true }));
  await assert.rejects(applyHostedSync(s.root, s.command(), s.transport), {
    code: 'CLI_UPGRADE_REQUIRED',
  });
  assert(existsSync(journal(s.root)));
});

test('a resumed apply flushes every directory it changed before publishing the marker', async t => {
  const { s, request, target } = await multiFile(t);
  await interruptSync(t, s, request, boundaries['marker publication']);
  const open = fs.openSync,
    rename = fs.renameSync,
    synced = new Set();
  let publishedAfter = null;
  t.mock.method(fs, 'openSync', (path, flags, ...rest) => {
    const fd = open(path, flags, ...rest);
    if (flags === 'r' && lstatSync(path).isDirectory()) synced.add(String(path));
    return fd;
  });
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (inStage(from) && String(to).endsWith('/client/.forge/hosted-lane.json'))
      publishedAfter = new Set(synced);
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    await applyHostedSync(s.root, request, s.transport);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assertTarget(s, request, target);
  assert(publishedAfter, 'the marker was published by the resumed apply');
  for (const directory of [s.root, join(s.root, 'd'), join(s.root, 'new'), join(s.root, 'gone')])
    assert(publishedAfter.has(directory), `${directory} flushed before the marker`);
});
