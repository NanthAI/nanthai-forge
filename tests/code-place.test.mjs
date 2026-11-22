// SPDX-License-Identifier: Apache-2.0
// The Code place (Items 90e5bc9c, 3968a655): the tree is read one folder at a time and never as a whole State; a
// folder page is bounded and resumes exactly; a deep link names its folders; history rows come from the receipt alone
// and show public handles; pinned States and line links are exact.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';

const tree = await import(moduleUrl('../src/code-tree.ts'));
const history = await import(moduleUrl('../src/code-history.ts'));
const words = await import(moduleUrl('../web/src/app/code/code-words.ts'));
const { folderPage, withChildren, ancestors, pathKind, changedPaths, CODE_DIR_PAGE, CODE_AHEAD_BYTES } = tree;
const { keepListing, listingNeed } = await import(moduleUrl('../web/src/app/code/listing.ts'));

const state = (...paths) =>
  paths.sort().map(path => ({ path, mode: path.endsWith('.lnk') ? 'symlink' : 'file' }));

test('a folder lists its folders first, then its files, with the files under each folder counted', () => {
  const files = state('src/b.ts', 'src/a/x.ts', 'src/a/y/z.ts', 'README.md', 'docs/one.md', 'src/c.lnk');
  const root = folderPage(files, '');
  assert.deepEqual(
    root.entries.map(entry => [entry.name, entry.kind, entry.files]),
    [
      ['docs', 'dir', 1],
      ['src', 'dir', 4],
      ['README.md', 'file', undefined],
    ],
  );
  const src = folderPage(files, 'src');
  assert.deepEqual(
    src.entries.map(entry => [entry.path, entry.kind]),
    [
      ['src/a', 'dir'],
      ['src/b.ts', 'file'],
      ['src/c.lnk', 'symlink'],
    ],
  );
  assert.equal(src.next, null);
});

test('a large folder is one bounded page at a time and the cursor resumes exactly where it stopped', () => {
  const files = state(...Array.from({ length: 450 }, (_, i) => `big/f${String(i).padStart(4, '0')}.ts`));
  const first = folderPage(files, 'big');
  assert.equal(first.entries.length, CODE_DIR_PAGE);
  assert.equal(first.total, 450);
  const second = folderPage(files, 'big', first.next);
  const third = folderPage(files, 'big', second.next);
  const seen = [...first.entries, ...second.entries, ...third.entries].map(entry => entry.path);
  assert.equal(new Set(seen).size, 450, 'no entry is skipped or repeated across pages');
  assert.equal(third.next, null);
});

test('listing a folder jumps past unrelated paths and descendants but counts them exactly', () => {
  const files = state(
    'src/a!/extra.ts',
    'src/a/z.ts',
    'src0/nearby.ts',
    ...Array.from({ length: 29_000 }, (_, i) => `src/a/nested/item${i}.ts`),
  );
  let inspected = 0;
  const paths = new Proxy(files, {
    get(target, key) {
      if (typeof key === 'string' && /^\d+$/.test(key)) inspected++;
      return Reflect.get(target, key);
    },
  });
  assert.deepEqual(
    folderPage(paths, 'src').entries.map(entry => [entry.name, entry.files]),
    [
      ['a', 29_001],
      ['a!', 1],
    ],
  );
  assert.ok(inspected <= 100, `listing inspected ${inspected} paths`);
});

test('a folder read lists that folder and one level ahead, within a byte budget and never the whole tree', () => {
  const files = state(
    'README.md',
    'src/a.ts',
    'src/state/b.ts',
    'src/state/deep/c.ts',
    'tests/t.mjs',
    'docs/d.md',
  );
  const dirs = withChildren(files, folderPage(files, ''));
  assert.deepEqual(
    dirs.map(dir => dir.path),
    ['', 'docs', 'src', 'tests'],
    'the folder first (the existing reply shape), then each folder it lists',
  );
  assert.deepEqual(
    dirs[2].entries.map(entry => entry.path),
    ['src/state', 'src/a.ts'],
    'a child is its own one-level page: src/state/deep stays unread until src/state is opened',
  );
  assert.ok(!dirs.some(dir => dir.path === 'src/state'));
  // Each child is a full first page; children that would cross the budget are left for their own read.
  const wide = state(
    ...Array.from({ length: 40 }, (_, i) => `f${String(i).padStart(2, '0')}/${'x'.repeat(60)}.ts`),
  );
  const one = JSON.stringify(folderPage(wide, 'f00')).length;
  const bounded = withChildren(wide, folderPage(wide, ''), one * 3);
  assert.equal(bounded.length, 1 + 3, 'stops at the byte budget');
  const sent = bounded.slice(1).reduce((sum, dir) => sum + JSON.stringify(dir).length, 0);
  assert.ok(sent <= one * 3);
  assert.ok(JSON.stringify(withChildren(wide, folderPage(wide, ''))).length <= CODE_AHEAD_BYTES + 8_192);

  const unicode = state('f00/é.ts');
  const child = JSON.stringify(folderPage(unicode, 'f00'));
  assert.equal(withChildren(unicode, folderPage(unicode, ''), child.length).length, 1);
  assert.equal(withChildren(unicode, folderPage(unicode, ''), Buffer.byteLength(child)).length, 2);
});

test('a warm tab opens a folder it already listed without a read, and asks once for the next level', () => {
  const files = state('src/a.ts', 'src/state/b.ts', 'src/state/deep/c.ts', 'tests/t.mjs');
  const cache = { dirs: new Map(), ahead: new Set() };
  keepListing(cache, { dirs: withChildren(files, folderPage(files, '')), ahead: '' });
  assert.equal(listingNeed(cache, 'tests'), 'none', 'a cached leaf folder opens without a background read');
  assert.equal(
    listingNeed(cache, 'src'),
    'ahead',
    'src is listed: it opens at once; only its children are fetched',
  );
  assert.equal(listingNeed(cache, ''), 'none');
  keepListing(cache, { dirs: withChildren(files, folderPage(files, 'src')), ahead: 'src' });
  assert.equal(listingNeed(cache, 'src'), 'none', 'the same folder is never read twice in a tab');
  assert.equal(listingNeed(cache, 'src/state'), 'ahead');
  assert.equal(listingNeed(cache, 'src/state/deep'), 'read', 'an unlisted folder is exactly one read');
  keepListing(cache, { dirs: [folderPage(files, 'src/state/deep')] });
  assert.equal(listingNeed(cache, 'src/state'), 'none', 'all visible subfolders are already cached');
  // A later page of a folder appends to that folder only; an ahead listing never replaces a known folder.
  const before = cache.dirs.get('src').entries.length;
  keepListing(cache, { dirs: [{ ...folderPage(files, 'src'), entries: [] }, folderPage(files, 'tests')] });
  assert.equal(cache.dirs.get('src').entries.length, before);
  keepListing(
    cache,
    {
      dirs: [
        { path: 'src', entries: [{ name: 'z.ts', path: 'src/z.ts', kind: 'file' }], total: 3, next: null },
      ],
    },
    'src',
  );
  assert.equal(cache.dirs.get('src').entries.at(-1).path, 'src/z.ts');
});

test('a deep link names exactly the folders on its way, and a path is a file, a folder or nothing', () => {
  assert.deepEqual(ancestors('src/parser/stream.ts', false), ['', 'src', 'src/parser']);
  assert.deepEqual(ancestors('src/parser', true), ['', 'src', 'src/parser']);
  assert.deepEqual(ancestors('', true), ['']);
  const files = state('src/parser/stream.ts', 'src/parserish.ts');
  assert.equal(pathKind(files, 'src/parser/stream.ts'), 'file');
  assert.equal(pathKind(files, 'src/parser'), 'dir');
  assert.equal(pathKind(files, 'src/pars'), null, 'a name prefix is not a folder');
  assert.equal(pathKind(files, 'gone.ts'), null);
});

test('what a landing changed lists only changed paths, bounded, with the true total', () => {
  const paths = [
    { path: 'a', status: 'unchanged' },
    { path: 'b', status: 'modified' },
    { path: 'c', status: 'added' },
    { path: 'd', status: 'deleted' },
  ];
  assert.deepEqual(changedPaths(paths), {
    changes: [
      { path: 'b', status: 'modified' },
      { path: 'c', status: 'added' },
      { path: 'd', status: 'deleted' },
    ],
    total: 3,
  });
  assert.equal(changedPaths(paths, 1).changes.length, 1);
  assert.equal(changedPaths(paths, 1).total, 3);
});

const head = 'a'.repeat(64),
  base = 'b'.repeat(64);
const receipt = (patch = {}) => ({
  id: '0f8d2c1e-5b7a-4c3d-9e21-6a4b8f0c7d35',
  at: '2026-11-17T09:58:00.000Z',
  message: 'Types: narrow ReadResult\n\nThe error arm could not happen.',
  actor: { kind: 'agent', id: 'account-1' },
  agentRun: 'amber-fox',
  agentClient: 'claude-code',
  candidate: { head },
  previous: { head: base, receiptId: 'r0' },
  automatic: true,
  check: { runId: 'run-1' },
  firstCheck: { landedOn: 'admission-run', mainMoved: false },
  ...patch,
});

test('a history row is the receipt alone: title, why, both States and the check, with the account as actor', () => {
  const row = history.codeHistoryRow(receipt(), 41);
  assert.equal(row.title, 'Types: narrow ReadResult');
  assert.equal(row.why, 'The error arm could not happen.');
  assert.equal(row.head, head);
  assert.equal(row.base, base);
  assert.equal(row.sequence, 41);
  assert.equal(row.actor, 'account-1', 'the public identity rule maps this key to a handle or removes it');
  assert.deepEqual(row.check, { runId: 'run-1', testsSkipped: false });
  assert.equal(row.firstCheck, 'admission-run');
  const bare = history.codeHistoryRow(receipt({ message: undefined, check: null, firstCheck: undefined }), 1);
  assert.equal(bare.title, null, 'no message is said as no title, never invented');
  assert.equal(bare.check, null);
  assert.equal(history.codeHistoryRow(receipt({ message: 'x'.repeat(500) }), 1).title.length, 200);
});

test('who landed it is a public handle: person/agent for an agent run, an agent when people are hidden', () => {
  assert.equal(words.landedBy({ actor: 'mara', agent: true, agentRun: 'amber-fox' }), 'mara/amber-fox');
  assert.equal(words.landedBy({ actor: 'mara', agent: false, agentRun: null }), '@mara');
  assert.equal(words.landedBy({ agent: true, agentRun: 'amber-fox' }), 'an agent');
  assert.equal(words.landedBy({ agent: false, agentRun: null }), null);
});

test('one day ago reads as one day (seen on the visitor history, Item 4c164732)', () => {
  const at = Date.UTC(2026, 10, 18, 12);
  assert.equal(words.ago(new Date(at - 86_400_000).toISOString(), at), '1 day ago');
  assert.equal(words.ago(new Date(at - 3 * 86_400_000).toISOString(), at), '3 days ago');
});

test('only an exact State pins the files, and only #L<number> selects a line', () => {
  assert.equal(words.pinnedState(`?at=${head}`), head);
  assert.equal(words.pinnedState('?at=main'), null);
  assert.equal(words.pinnedState(`?at=${head.toUpperCase()}`), null);
  assert.equal(words.selectedLine('#L42'), 42);
  assert.equal(words.selectedLine('#L4x'), null);
  assert.equal(words.selectedLine('#top'), null);
});

test('time to main is said from the two stored times, and missing times are not guessed', () => {
  assert.equal(words.between('2026-11-17T09:52:48Z', '2026-11-17T09:58:00Z'), '5 min 12 s');
  assert.equal(words.between(null, '2026-11-17T09:58:00Z'), null);
  assert.equal(words.between('2026-11-17T09:58:00Z', '2026-11-17T09:00:00Z'), null);
});

test('the receipt evidence window comes from the receipt time alone, so the read never re-runs on the clock', () => {
  assert.deepEqual(words.receiptWindow('2026-11-17T09:58:00.000Z'), {
    from: '2026-11-17T09:57:59.000Z',
    to: '2026-11-17T09:59:00.000Z',
  });
  assert.equal(words.receiptWindow('not a time'), null);
});

test('What landed narrows to one file only by its ?path= address, and its links keep that path (Item 3968a655)', () => {
  assert.equal(words.timelinePath('?path=src/parser/stream.ts'), 'src/parser/stream.ts');
  assert.equal(words.timelinePath('?path=src%2Fparser%2Fstream.ts'), 'src/parser/stream.ts');
  assert.equal(
    words.timelinePath('?path=%20README.md'),
    ' README.md',
    'the address is read verbatim: a file name may start with a space (review of Lane 2954c0e3)',
  );
  assert.equal(
    words.timelinePath(new URL(words.pathHref('/x', ' README.md'), 'https://forge.test').search),
    ' README.md',
  );
  assert.equal(words.typedPath('  /src/a.ts '), 'src/a.ts', 'typing loses edge spaces and a leading slash');
  assert.equal(words.typedPath('   '), null);
  assert.equal(words.timelinePath('?path='), null, 'an empty path lists every landing');
  assert.equal(words.timelinePath('?at=' + head), null);
  assert.equal(words.pathHref('/ada/atlas/code', 'src/a b&c.ts'), '/ada/atlas/code?path=src/a%20b%26c.ts');
  assert.equal(
    words.timelinePath(new URL(words.pathHref('/x', 'src/a b&c.ts'), 'https://forge.test').search),
    'src/a b&c.ts',
    'the address reads back as the same path',
  );
  assert.equal(words.pathHref('/ada/atlas/code', null), '/ada/atlas/code');
});
