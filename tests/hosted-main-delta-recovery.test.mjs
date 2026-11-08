// SPDX-License-Identifier: Apache-2.0
// The clone root (nforge pull) applies through the same in-place delta journal as Lane checkouts.
// A crash is simulated by failing every later write to the checkout and its delta folders, as if
// the process had died at that boundary (its work lock is released, as a dead holder's would be
// detected). An error inside a live pull instead undoes the root at once (hosted-pull tests).
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
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { pullFixture } from './hosted-pull-fixture.mjs';
import { pullHostedProject } from '../dist/hosted-pull.js';
import { checkoutHostedMain } from '../dist/hosted-main-checkout.js';
import { readHostedMainMarker } from '../dist/hosted-main-marker.js';
import { clientCacheRoot } from '../dist/root-paths.js';

const pull = f => pullHostedProject(f.root, f.address, f.transport);
const cache = f => clientCacheRoot(f.root);
const journal = f => join(cache(f), 'delta-apply.json');
const deltaDirectories = f => readdirSync(cache(f)).filter(name => name.startsWith('delta-'));
const inStage = path => /\/delta-[A-Za-z0-9]+\//.test(String(path)) && !String(path).includes('-displaced/');
/** Another command on the same clone: a fresh refresh operation, not the pending pull. */
const otherPull = f =>
  checkoutHostedMain(
    f.root,
    { url: f.address.url, projectId: f.address.projectId, operationId: randomUUID(), refresh: true },
    f.transport,
  );

/** d/one.txt, d/two.txt and src/0.txt change, new/n.txt arrives, gone/x.txt leaves; gone/ also
 * holds ignored output, so it is emptied but not removed. */
async function multiFile(t) {
  const f = pullFixture(t);
  f.select([
    ['.gitignore', '*.log\n'],
    ['d/one.txt', 'one before\n'],
    ['d/two.txt', 'two before\n'],
    ['gone/x.txt', 'removed upstream\n'],
  ]);
  await pull(f);
  writeFileSync(join(f.root, 'gone/out.log'), 'ignored output');
  const target = {
    'd/one.txt': 'one after\n',
    'd/two.txt': 'two after\n',
    'new/n.txt': 'arrived\n',
    'src/0.txt': 'zero after\n',
  };
  f.select([...Object.entries(target), ['gone/x.txt', null]]);
  return { f, target, inode: statSync(f.root).ino };
}
const mutating = [
  'renameSync',
  'rmSync',
  'rmdirSync',
  'unlinkSync',
  'writeFileSync',
  'mkdirSync',
  'linkSync',
  'symlinkSync',
  'copyFileSync',
  'chmodSync',
];
/** Fail once at `match` (before the call runs), then fail every later write to the checkout or its
 * delta folders, like a process killed there. */
function crashAt(t, f, match) {
  let dead = false;
  const owned = path => {
    const text = String(path);
    return (
      text === f.root ||
      text.startsWith(`${f.root}/`) ||
      /\/delta-[^/]*$|\/delta-[^/]+\/|delta-apply\.json/.test(text.slice(cache(f).length))
    );
  };
  for (const name of mutating) {
    const real = fs[name];
    t.mock.method(fs, name, (...args) => {
      if (!dead && match(name, String(args[0]), String(args[1]))) dead = true;
      if (dead && (owned(args[0]) || (name === 'renameSync' && owned(args[1]))))
        throw new Error('synthetic crash');
      return real(...args);
    });
  }
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', (path, flags, ...rest) => {
    if (dead && flags !== 'r' && owned(path)) throw new Error('synthetic crash');
    return open(path, flags, ...rest);
  });
  syncBuiltinESMExports();
  return () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    return dead;
  };
}
async function crashPull(t, f, match) {
  const restore = crashAt(t, f, match);
  try {
    await assert.rejects(pull(f), /synthetic crash/);
  } finally {
    assert(restore(), 'the crash boundary was reached');
  }
  assert(existsSync(journal(f)), 'the crash left the apply journal');
}
function assertTarget(f, target, inode) {
  assert.equal(readHostedMainMarker(f.root).selection.head, f.main().head);
  for (const [path, content] of Object.entries(target))
    assert.equal(readFileSync(join(f.root, path), 'utf8'), content, path);
  assert.equal(existsSync(join(f.root, 'gone/x.txt')), false);
  assert.equal(readFileSync(join(f.root, 'gone/out.log'), 'utf8'), 'ignored output');
  assert.equal(existsSync(journal(f)), false);
  assert.deepEqual(deltaDirectories(f), []);
  assert.equal(statSync(f.root).ino, inode, 'the clone root is never swapped');
}
const boundaries = {
  'a later move aside': (name, from) => name === 'renameSync' && from.endsWith('/clone/d/two.txt'),
  'first install': (name, from, to) =>
    name === 'renameSync' && inStage(from) && to.endsWith('/clone/d/one.txt'),
  'second install': (name, from, to) =>
    name === 'renameSync' && inStage(from) && to.endsWith('/clone/d/two.txt'),
  'last install': (name, from, to) =>
    name === 'renameSync' && inStage(from) && to.endsWith('/clone/src/0.txt'),
  'marker publication': (name, from, to) =>
    name === 'renameSync' && inStage(from) && to.endsWith('/clone/.forge/hosted-main.json'),
  'journal removal': (name, path) => name === 'rmSync' && path.endsWith('/delta-apply.json'),
};

test('a pull killed at any step is finished by the next pull or another refresh, never left mixed', async t => {
  let other = false;
  for (const [name, match] of Object.entries(boundaries)) {
    const { f, target, inode } = await multiFile(t);
    await crashPull(t, f, match);
    const result = other ? await otherPull(f) : await pull(f);
    assert.equal(result.head, f.main().head, name);
    assertTarget(f, target, inode);
    other = !other;
  }
});

test('a missing stage rolls the half-applied root back and the same pull then completes', async t => {
  const { f, target, inode } = await multiFile(t);
  await crashPull(t, f, boundaries['second install']);
  rmSync(join(cache(f), JSON.parse(readFileSync(journal(f), 'utf8')).stage), { recursive: true });
  await pull(f);
  assertTarget(f, target, inode);
});

test('a marker rewritten after the crash is never replaced and the journal is kept', async t => {
  const { f } = await multiFile(t);
  await crashPull(t, f, boundaries['marker publication']);
  const marker = join(f.root, '.forge/hosted-main.json');
  const rewritten = JSON.stringify(JSON.parse(readFileSync(marker, 'utf8')), null, 1);
  writeFileSync(marker, rewritten);
  await assert.rejects(pull(f), error => {
    assert.equal(error.code, 'WORK_CONFLICT');
    assert.equal(error.recovery.obstruction.kind, 'delta-apply-pending');
    assert.match(error.message, /nforge clone the project into a new directory/);
    return true;
  });
  assert.equal(readFileSync(marker, 'utf8'), rewritten);
  assert(existsSync(journal(f)));
});

test('an edit made after a crash, before anything was installed, refuses and stays in place', async t => {
  const { f } = await multiFile(t);
  const marker = readFileSync(join(f.root, '.forge/hosted-main.json'));
  await crashPull(t, f, boundaries['a later move aside']);
  writeFileSync(join(f.root, 'd/two.txt'), 'edited after the crash\n');
  await assert.rejects(pull(f), { code: 'WORK_CONFLICT' });
  assert.equal(readFileSync(join(f.root, 'd/two.txt'), 'utf8'), 'edited after the crash\n');
  assert.equal(readFileSync(join(f.root, 'd/one.txt'), 'utf8'), 'one before\n', 'moved-aside bytes return');
  assert.equal(readFileSync(join(f.root, 'gone/x.txt'), 'utf8'), 'removed upstream\n');
  assert.deepEqual(readFileSync(join(f.root, '.forge/hosted-main.json')), marker);
  assert.deepEqual(deltaDirectories(f), []);
});

test('a refusal killed half-way resumes as a refusal, never as an install', async t => {
  const { f } = await multiFile(t);
  const write = fs.writeFileSync;
  let raced = false;
  const restore = crashAt(t, f, (name, from, to) => {
    // A local edit lands on d/one.txt just before it moves aside; the rollback is then killed
    // while restoring d/two.txt.
    if (name === 'renameSync' && !raced && from === join(f.root, 'd/one.txt')) {
      raced = true;
      write(from, 'racing local edit\n');
    }
    return name === 'renameSync' && from.includes('-displaced/') && to.endsWith('/clone/d/two.txt');
  });
  try {
    await assert.rejects(pull(f), /synthetic crash/);
  } finally {
    assert(restore());
  }
  assert(raced);
  assert.equal(JSON.parse(readFileSync(journal(f), 'utf8')).aborting, true);
  await assert.rejects(pull(f), { code: 'WORK_CONFLICT' });
  assert.equal(readFileSync(join(f.root, 'd/one.txt'), 'utf8'), 'racing local edit\n');
  assert.equal(readFileSync(join(f.root, 'd/two.txt'), 'utf8'), 'two before\n');
  assert.equal(readFileSync(join(f.root, 'src/0.txt'), 'utf8'), 'source 0\n');
  assert.notEqual(readHostedMainMarker(f.root).selection.head, f.main().head);
  assert.deepEqual(deltaDirectories(f), []);
});

test('a file recreated at an incoming path after installing began is kept aside and reported', async t => {
  const { f, target, inode } = await multiFile(t);
  await crashPull(t, f, boundaries['second install']);
  mkdirSync(join(f.root, 'new'), { recursive: true });
  writeFileSync(join(f.root, 'new/n.txt'), 'my own draft\n');
  const result = await pull(f);
  assert.match(result.warning, /kept at/);
  const [kept] = result.displacedRecovery;
  const spares = readdirSync(join(kept, 'occupied'));
  assert.equal(readFileSync(join(kept, 'occupied', spares[0], 'new/n.txt'), 'utf8'), 'my own draft\n');
  assert.equal(readHostedMainMarker(f.root).selection.head, f.main().head);
  for (const [path, content] of Object.entries(target))
    assert.equal(readFileSync(join(f.root, path), 'utf8'), content, path);
  assert.equal(statSync(f.root).ino, inode);
});

test('a parent replaced by a link after a crash is refused, never followed', async t => {
  const { f } = await multiFile(t);
  await crashPull(t, f, boundaries['a later move aside']);
  const outside = join(dirname(f.root), 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'two.txt'), 'outside bytes');
  renameSync(join(f.root, 'd'), join(f.root, 'd-moved'));
  symlinkSync(outside, join(f.root, 'd'));
  const refused = await pull(f).then(
    () => null,
    error => error,
  );
  assert.deepEqual(readdirSync(outside), ['two.txt'], 'nothing is installed outside the checkout');
  assert.equal(readFileSync(join(outside, 'two.txt'), 'utf8'), 'outside bytes');
  assert.equal(refused?.code, 'WORK_CONFLICT');
  assert.deepEqual(refused.recovery.obstruction, { kind: 'delta-apply-pending', path: 'd' });
  assert(existsSync(journal(f)));
});

test('a journal from a newer client asks for an upgrade instead of failing to parse', async t => {
  const f = pullFixture(t);
  f.select([['src/0.txt', 'next']]);
  writeFileSync(journal(f), JSON.stringify({ schema: 4, future: true }));
  await assert.rejects(pull(f), { code: 'CLI_UPGRADE_REQUIRED' });
  assert(existsSync(journal(f)));
});

test('a resumed pull flushes every directory it changed before publishing the marker', async t => {
  const { f, target, inode } = await multiFile(t);
  await crashPull(t, f, boundaries['marker publication']);
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
    if (inStage(from) && String(to).endsWith('/clone/.forge/hosted-main.json'))
      publishedAfter = new Set(synced);
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    await pull(f);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assertTarget(f, target, inode);
  assert(publishedAfter, 'the marker was published by the resumed pull');
  for (const directory of [
    f.root,
    join(f.root, 'd'),
    join(f.root, 'new'),
    join(f.root, 'gone'),
    join(f.root, 'src'),
  ])
    assert(publishedAfter.has(directory), `${directory} flushed before the marker`);
});

test('file/directory flips apply in place, survive a crash and undo cleanly after an error', async t => {
  const f = pullFixture(t),
    inode = statSync(f.root).ino;
  // File to directory, killed after the old file moved aside: the next pull finishes it.
  f.select([
    ['src/0.txt', null],
    ['src/0.txt/nested/deep', 'nested'],
  ]);
  await crashPull(t, f, (name, from, to) => name === 'renameSync' && inStage(from) && to.endsWith('/deep'));
  await pull(f);
  assert.equal(readFileSync(join(f.root, 'src/0.txt/nested/deep'), 'utf8'), 'nested');
  // Directory back to a file, failing inside a live pull after the file landed: undone at once.
  f.select([
    ['src/0.txt/nested/deep', null],
    ['src/0.txt', 'file again'],
  ]);
  const rename = fs.renameSync;
  let failed = false;
  t.mock.method(fs, 'renameSync', (from, to) => {
    const value = rename(from, to);
    if (!failed && inStage(from) && String(to) === join(f.root, 'src/0.txt')) {
      failed = true;
      throw new Error('synthetic failure');
    }
    return value;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(pull(f), /synthetic failure/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert(failed);
  assert.equal(
    readFileSync(join(f.root, 'src/0.txt/nested/deep'), 'utf8'),
    'nested',
    'undone to the directory',
  );
  assert(!existsSync(journal(f)));
  await pull(f);
  assert.equal(readFileSync(join(f.root, 'src/0.txt'), 'utf8'), 'file again');
  assert.equal(statSync(f.root).ino, inode, 'the clone root is never swapped');
  assert.deepEqual(deltaDirectories(f), []);
});

/** README.md and Docs/ (with Docs/Sub/ and an ignored build output) are renamed by case only;
 * main also changes README's bytes. */
async function caseOnly(t) {
  const f = pullFixture(t);
  f.select([
    ['.gitignore', '*.log\n'],
    ['README.md', 'old readme\n'],
    ['Docs/a.md', 'guide\n'],
    ['Docs/Sub/b.md', 'nested\n'],
  ]);
  await pull(f);
  writeFileSync(join(f.root, 'Docs/out.log'), 'ignored output');
  const inode = statSync(f.root).ino,
    docs = statSync(join(f.root, 'Docs')).ino;
  f.select([
    ['README.md', null],
    ['Docs/a.md', null],
    ['Docs/Sub/b.md', null],
    ['readme.md', 'new readme\n'],
    ['docs/a.md', 'guide\n'],
    ['docs/sub/b.md', 'nested\n'],
  ]);
  return { f, inode, docs };
}
function assertCaseOnly(f, inode, docs) {
  assert.equal(readHostedMainMarker(f.root).selection.head, f.main().head);
  const names = readdirSync(f.root);
  assert(names.includes('readme.md') && !names.includes('README.md'), names.join(','));
  assert(names.includes('docs') && !names.includes('Docs'), names.join(','));
  assert.deepEqual(readdirSync(join(f.root, 'docs')).sort(), ['a.md', 'out.log', 'sub']);
  assert.deepEqual(readdirSync(join(f.root, 'docs/sub')), ['b.md']);
  assert.equal(readFileSync(join(f.root, 'readme.md'), 'utf8'), 'new readme\n');
  assert.equal(readFileSync(join(f.root, 'docs/sub/b.md'), 'utf8'), 'nested\n');
  assert.equal(readFileSync(join(f.root, 'docs/out.log'), 'utf8'), 'ignored output');
  assert.equal(statSync(join(f.root, 'docs')).ino, docs, 'the directory is renamed, not rebuilt');
  assert.equal(statSync(f.root).ino, inode, 'the clone root is never swapped');
  assert.equal(existsSync(journal(f)), false);
  assert.deepEqual(deltaDirectories(f), []);
  assert(!names.some(name => name.startsWith('.forge-respell-')), names.join(','));
}
const respelling = (name, from) => name === 'renameSync' && from.includes('/.forge-respell-');

test('a case-only rename of a file and a directory applies in place with the exact spelling', async t => {
  const { f, inode, docs } = await caseOnly(t);
  f.reset();
  const result = await pull(f);
  assert.equal(result.head, f.main().head);
  assertCaseOnly(f, inode, docs);
  // Only the manifest and README's new bytes are fetched; renamed bytes come from the clone.
  assert.equal(f.calls.gets.length, 2);
});

test('a pull killed between the two renames of a directory spelling is finished by the next pull', async t => {
  const { f, inode, docs } = await caseOnly(t);
  await crashPull(t, f, respelling);
  assert(
    readdirSync(f.root).some(name => name.startsWith('.forge-respell-')),
    'killed at the temporary name',
  );
  await pull(f);
  assertCaseOnly(f, inode, docs);
});

test('a respelled directory whose stage is lost rolls back and the same pull then completes', async t => {
  const { f, inode, docs } = await caseOnly(t);
  // Killed after the directory took its new spelling and before anything was installed.
  await crashPull(
    t,
    f,
    (name, from, to) => name === 'renameSync' && inStage(from) && to.startsWith(`${f.root}/`),
  );
  rmSync(join(cache(f), JSON.parse(readFileSync(journal(f), 'utf8')).stage), { recursive: true });
  await pull(f);
  assertCaseOnly(f, inode, docs);
});

test('an error inside a live pull after a directory took its new spelling restores the old one', async t => {
  const { f, inode, docs } = await caseOnly(t);
  const rename = fs.renameSync;
  let failed = false;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (!failed && inStage(from) && String(to).startsWith(`${f.root}/`)) {
      failed = true;
      throw new Error('synthetic failure');
    }
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(pull(f), /synthetic failure/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  const names = readdirSync(f.root);
  assert(names.includes('Docs') && !names.includes('docs'), names.join(','));
  assert(names.includes('README.md') && !names.includes('readme.md'), names.join(','));
  assert.deepEqual(readdirSync(join(f.root, 'Docs')).sort(), ['Sub', 'a.md', 'out.log']);
  assert.equal(readFileSync(join(f.root, 'README.md'), 'utf8'), 'old readme\n');
  assert.equal(readFileSync(join(f.root, 'Docs/Sub/b.md'), 'utf8'), 'nested\n');
  assert.equal(existsSync(journal(f)), false);
  await pull(f);
  assertCaseOnly(f, inode, docs);
});

test('a normalization-only rename (NFD to NFC) applies in place with the exact spelling', async t => {
  const nfd = 'cafe\u0301',
    nfc = 'caf\u00e9';
  const f = pullFixture(t);
  f.select([
    [`${nfd}.txt`, 'old menu\n'],
    [`${nfd}/x.txt`, 'inside\n'],
  ]);
  await pull(f);
  const inode = statSync(f.root).ino;
  f.select([
    [`${nfd}.txt`, null],
    [`${nfd}/x.txt`, null],
    [`${nfc}.txt`, 'new menu\n'],
    [`${nfc}/x.txt`, 'inside\n'],
  ]);
  await pull(f);
  const names = readdirSync(f.root);
  assert(names.includes(`${nfc}.txt`) && !names.includes(`${nfd}.txt`), JSON.stringify(names));
  assert(names.includes(nfc) && !names.includes(nfd), JSON.stringify(names));
  assert.equal(readFileSync(join(f.root, `${nfc}.txt`), 'utf8'), 'new menu\n');
  assert.equal(readFileSync(join(f.root, nfc, 'x.txt'), 'utf8'), 'inside\n');
  assert.equal(readHostedMainMarker(f.root).selection.head, f.main().head);
  assert.equal(statSync(f.root).ino, inode, 'the clone root is never swapped');
  assert.deepEqual(deltaDirectories(f), []);
});

test('an untracked obstruction refuses before any object is fetched or staged', async t => {
  const f = pullFixture(t, 50);
  // A stray file holds an incoming parent; a folder with only unsaved Finder state holds an
  // incoming file. Both are refused by the clean check too, so nothing is ever staged for them.
  for (const [setup, change, path] of [
    [() => writeFileSync(join(f.root, 'new'), 'stray'), ['new/n.txt', 'arrived\n'], 'new'],
    [
      () => {
        mkdirSync(join(f.root, 'dist'));
        writeFileSync(join(f.root, 'dist/.DS_Store'), 'finder');
      },
      ['dist', 'incoming file\n'],
      'dist',
    ],
  ]) {
    setup();
    f.select([['src/0.txt', `changed for ${path}\n`], change]);
    const objects = readdirSync(join(cache(f), 'objects')).sort();
    const mkdtemp = fs.mkdtempSync,
      stages = [];
    t.mock.method(fs, 'mkdtempSync', (prefix, ...rest) => {
      stages.push(basename(String(prefix)));
      return mkdtemp(prefix, ...rest);
    });
    syncBuiltinESMExports();
    f.reset();
    try {
      await assert.rejects(pull(f), error => {
        assert.equal(error.code, 'WORK_CONFLICT');
        assert.deepEqual(error.recovery.obstruction, { kind: 'extra-source', path });
        return true;
      });
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    // Only the selected manifest is read: no blob page, download, reuse copy or stage.
    assert.deepEqual(f.calls.gets, [f.main().head]);
    assert.deepEqual(f.calls.pages, [[f.main().head]]);
    assert.deepEqual(
      stages.filter(name => /^(delta|checkout|reuse)-$/.test(name)),
      [],
      stages.join(','),
    );
    assert.deepEqual(readdirSync(join(cache(f), 'objects')).sort(), [...objects, f.main().head].sort());
    rmSync(join(f.root, path), { recursive: true });
    await pull(f);
    assert.equal(readHostedMainMarker(f.root).selection.head, f.main().head);
  }
});

test('a legacy per-file publication journal from an older client still rolls back first', async t => {
  const f = pullFixture(t);
  const old = readHostedMainMarker(f.root);
  // An older client was killed after linking the new src/0.txt into place.
  const stage = 'checkout-legacy1';
  mkdirSync(join(cache(f), stage, 'src'), { recursive: true });
  mkdirSync(join(cache(f), 'publish-backup/src'), { recursive: true });
  renameSync(join(f.root, 'src/0.txt'), join(cache(f), 'publish-backup/src/0.txt'));
  writeFileSync(join(f.root, 'src/0.txt'), 'legacy incoming\n');
  const zero = old.state.files.find(file => file.path === 'src/0.txt');
  const { digest } = await import('../dist/hash.js');
  writeFileSync(
    join(cache(f), 'publish.json'),
    JSON.stringify({
      before: [zero],
      after: [{ path: 'src/0.txt', blob: digest('legacy incoming\n'), mode: 'file' }],
      marker: 'never published',
      stage,
    }),
  );
  f.select([['src/1.txt', 'one after\n']]);
  await pull(f);
  assert.equal(readFileSync(join(f.root, 'src/0.txt'), 'utf8'), 'source 0\n');
  assert.equal(readFileSync(join(f.root, 'src/1.txt'), 'utf8'), 'one after\n');
  assert(!existsSync(join(cache(f), 'publish.json')));
  assert(!existsSync(join(cache(f), 'publish-backup')));
  assert(!existsSync(join(cache(f), stage)));
});

test('a pull reads only changed files once the clone has a stat index', async t => {
  const f = pullFixture(t, 50);
  await delay(250); // Fixture files age past the racy window; the first pull indexes them.
  f.select([['src/0.txt', 'first change\n']]);
  await pull(f);
  await delay(250);
  f.select([['src/1.txt', 'second change\n']]);
  const read = fs.readFileSync,
    paths = [];
  t.mock.method(fs, 'readFileSync', (path, ...rest) => {
    const text = String(path);
    if (text.startsWith(`${cache(f)}/`) && text.includes('-displaced/')) paths.push(basename(text));
    if (text.startsWith(`${f.root}/`) && !text.startsWith(`${f.root}/.forge/`))
      paths.push(text.slice(f.root.length + 1));
    return read(path, ...rest);
  });
  syncBuiltinESMExports();
  try {
    await pull(f);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(readFileSync(join(f.root, 'src/1.txt'), 'utf8'), 'second change\n');
  // Only the replaced file's moved-aside copy is verified; no unchanged file is hashed again, and
  // src/0.txt (installed by the previous pull) was refreshed by that pull's clean check or this one.
  assert(paths.length <= 3, `checkout reads: ${paths.join(', ')}`);
  assert(!paths.some(path => /^src\/([2-9]|[1-4][0-9])\.txt$/.test(path)), paths.join(', '));
});
