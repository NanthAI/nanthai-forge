// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// A declared split survives raw edits (Item 491ddd77). The docs/agents/workflow.md split took 6
// rounds on 2026-11-19: every raw edit of the old file that landed while the split waited sent it
// back for a manual fold. Composition now moves each raw hunk into the fragment that holds those
// lines, in one round; a hunk across fragments, or on a line the split itself changed, still conflicts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { remapSplitEdit } from '../dist/doc-split-remap.js';
import { assembleDocument } from '../dist/doc-fragments.js';
import {
  resolveDocsComposition,
  resolveMarkdownText,
  SPLIT_BYTES_MAX,
  SPLIT_FRAGMENTS_MAX,
} from '../dist/native-docs-resolve.js';
import { NativeSource } from '../dist/native-source.js';
import { buildComposePages } from '../dist/hosted-compose.js';
import { saveBytes } from '../dist/hosted-save.js';
import { composeFixture } from './hosted-compose-fixture.mjs';

const at = '2026-01-01T00:00:00.000Z';
const DOC = 'docs/agents/guide.md',
  DIR = 'docs/agents/guide.d/sections';
// The pre-split document: three sections, a relative link, and a paragraph per section.
const base = [
  '# Guide',
  '',
  '## One',
  '',
  'First paragraph, see [status](../status.md).',
  '',
  '## Two',
  '',
  'Second paragraph.',
  'Second, line two.',
  '',
  '## Three',
  '',
  'Third paragraph.',
  '',
].join('\n');
const skeleton = '# Guide\n\nEntries: [guide.d/sections](guide.d/sections/)\n';
// Links inside a fragment are written relative to the fragment's own folder.
const fragments = {
  [`${DIR}/0100-one.md`]: '## One\n\nFirst paragraph, see [status](../../../status.md).\n',
  [`${DIR}/0200-two.md`]: '## Two\n\nSecond paragraph.\nSecond, line two.\n',
  [`${DIR}/0300-three.md`]: '## Three\n\nThird paragraph.\n',
};
const readerOf = files => ({
  list: directory =>
    Object.keys(files).flatMap(path =>
      path.startsWith(`${directory}/`) && !path.slice(directory.length + 1).includes('/')
        ? [path.slice(directory.length + 1)]
        : [],
    ),
  read: path => files[path],
});
const remap = (raw, extra = {}) =>
  remapSplitEdit({
    path: DOC,
    base: extra.base ?? base,
    raw,
    skeleton: extra.skeleton ?? skeleton,
    reader: readerOf(extra.fragments ?? fragments),
  });

test('the split assembles to the old document, so the fixture is a faithful split', () => {
  assert.equal(assembleDocument(DOC, skeleton, readerOf(fragments)), base);
});

test('a raw paragraph added to a section lands in that section’s fragment, link relinked', () => {
  const raw = base.replace(
    'Second, line two.\n',
    'Second, line two.\n\nAdded paragraph, see [plan](../phase7-plan.md).\n',
  );
  const result = remap(raw);
  assert(result, 'the hunk maps to one fragment');
  assert.equal(result.skeleton, skeleton, 'the skeleton is unchanged');
  assert.deepEqual([...result.fragments.keys()], [`${DIR}/0200-two.md`]);
  assert.equal(
    result.fragments.get(`${DIR}/0200-two.md`),
    '## Two\n\nSecond paragraph.\nSecond, line two.\n\nAdded paragraph, see [plan](../../../phase7-plan.md).\n',
  );
  const merged = { ...fragments, ...Object.fromEntries(result.fragments) };
  assert.equal(assembleDocument(DOC, result.skeleton, readerOf(merged)), raw, 'nothing lost or duplicated');
});

test('an edited line, a paragraph after a joiner, and a final paragraph each go to their own fragment', () => {
  const raw = base
    .replace('Second paragraph.', 'Second paragraph, edited.')
    .replace('## Three', 'Between two and three.\n\n## Three')
    .replace('Third paragraph.\n', 'Third paragraph.\n\nThe end.\n');
  const result = remap(raw);
  assert(result);
  assert.equal(
    result.fragments.get(`${DIR}/0200-two.md`),
    '## Two\n\nSecond paragraph, edited.\nSecond, line two.\n\nBetween two and three.\n',
    'a paragraph before the next heading ends the section above it',
  );
  assert.equal(result.fragments.get(`${DIR}/0300-three.md`), '## Three\n\nThird paragraph.\n\nThe end.\n');
  assert.equal(result.fragments.has(`${DIR}/0100-one.md`), false);
  const merged = { ...fragments, ...Object.fromEntries(result.fragments) };
  assert.equal(assembleDocument(DOC, result.skeleton, readerOf(merged)), raw);
});

test('a hunk across two fragments, or on a line the split changed, stays a conflict', () => {
  // One hunk replaces the end of section two, the blank line between entries and the start of three.
  assert.equal(
    remap(base.replace('Second, line two.\n\n## Three\n\n', 'Second and three, one line.\n')),
    null,
  );
  // Deleting the blank line assembly puts between two entries is not any fragment's edit.
  assert.equal(remap(base.replace('Second, line two.\n\n## Three', 'Second, line two.\n## Three')), null);
  // Two separate hunks in neighbouring sections are two single-fragment edits, not one across.
  const neighbours = base.replace(
    'First paragraph, see [status](../status.md).\n\n## Two',
    'First, rewritten.\n\n## Two, renamed',
  );
  const both = remap(neighbours);
  assert.deepEqual([...both.fragments.keys()], [`${DIR}/0100-one.md`, `${DIR}/0200-two.md`]);
  assert.equal(
    assembleDocument(DOC, both.skeleton, readerOf({ ...fragments, ...Object.fromEntries(both.fragments) })),
    neighbours,
  );
  // The split dropped a doubled blank line; a raw edit next to it is the split's own change.
  const doubled = base.replace('## Two\n', '## Two\n\n');
  assert.equal(assembleDocument(DOC, skeleton, readerOf(fragments)) === doubled, false);
  assert.equal(remap(doubled.replace('## Two\n\n\n', '## Two\n\nNew intro.\n\n'), { base: doubled }), null);
  // An edit a line away from it is not: the split did not change that line.
  const away = doubled.replace('Second paragraph.', 'Second paragraph, edited.');
  assert.equal(
    remap(away, { base: doubled }).fragments.get(`${DIR}/0200-two.md`),
    '## Two\n\nSecond paragraph, edited.\nSecond, line two.\n',
  );
  // A raw side that is itself split, or no split at all, is not this rule.
  assert.equal(remap(skeleton), null);
  assert.equal(remap(base.replace('Third', 'Third!'), { skeleton: base }), null);
});

test('a new table row joins the row file before it; assembly still reads one table', () => {
  const tableBase = '# Tables\n\n| table | where |\n| - | - |\n| alpha | hot |\n| gamma | cold |\n';
  const tableSkeleton = '# Tables\n\nEntries: [guide.d/rows](guide.d/rows/)\n';
  const rows = {
    'docs/agents/guide.d/rows/0000-header.md': '| table | where |\n| - | - |\n',
    'docs/agents/guide.d/rows/alpha.md': '| alpha | hot |\n',
    'docs/agents/guide.d/rows/gamma.md': '| gamma | cold |\n',
  };
  assert.equal(assembleDocument(DOC, tableSkeleton, readerOf(rows)), tableBase);
  const raw = tableBase.replace('| gamma', '| beta | warm |\n| gamma');
  const result = remap(raw, { base: tableBase, skeleton: tableSkeleton, fragments: rows });
  assert(result);
  assert.equal(
    result.fragments.get('docs/agents/guide.d/rows/alpha.md'),
    '| alpha | hot |\n| beta | warm |\n',
  );
  const merged = { ...rows, ...Object.fromEntries(result.fragments) };
  assert.equal(assembleDocument(DOC, result.skeleton, readerOf(merged)), raw);
});

// Composition: the same rule through resolveDocsComposition, which hosted compose, batch peers,
// hosted and CLI sync, and landing compose all call when the plain merge conflicts.
function disk(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-split-remap-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const source = new NativeSource(root);
  const file = (path, text) => ({ path, mode: 'file', blob: source.put(Buffer.from(text)) });
  const state = (files, parents = []) =>
    source.writeState(
      [...files].sort((a, b) => (a.path < b.path ? -1 : 1)),
      parents,
      'synthetic',
      at,
    );
  return { source, file, state };
}
const bytesAt = (source, head, path) => {
  const file = source.state(head).files.find(item => item.path === path);
  return file ? source.object(file.blob).toString('utf8') : undefined;
};
const raw = base.replace('Third paragraph.\n', 'Third paragraph.\n\nRaw edit landed meanwhile.\n');
function sides({ file, state }) {
  const other = file('src/other.ts', 'export const other = 1;\n');
  const root = state([file(DOC, base), other]);
  const split = state(
    [file(DOC, skeleton), other, ...Object.entries(fragments).map(([path, text]) => file(path, text))],
    [root],
  );
  const edited = state([file(DOC, raw), other], [root]);
  return { root, split, edited };
}

test('a split composed over a racing raw edit lands once, with the edit in the right fragment', t => {
  const d = disk(t),
    { split, edited } = sides(d);
  // Before: the plain merge conflicts on the old file, so the split was sent back.
  assert.equal(d.source.compose(edited, split, 'Compose', at).head, undefined);
  const expected = {
    ...fragments,
    [`${DIR}/0300-three.md`]: '## Three\n\nThird paragraph.\n\nRaw edit landed meanwhile.\n',
  };
  for (const [lane, main, mainFirst, label] of [
    [split, edited, true, 'hosted compose: the split onto main with the raw edit'],
    [split, edited, false, 'sync: the split Lane onto main'],
    [edited, split, true, 'hosted compose: a queued raw edit onto main with the split'],
    [edited, split, false, 'sync: a raw-edit Lane onto main with the split'],
  ]) {
    const result = resolveDocsComposition(d.source, lane, main, 'Compose', at, { mainFirst });
    assert(result, label);
    assert.equal(bytesAt(d.source, result.head, DOC), skeleton, `${label}: the skeleton stays`);
    for (const [path, text] of Object.entries(expected))
      assert.equal(bytesAt(d.source, result.head, path), text, `${label}: ${path}`);
    assert.deepEqual(result.paths, [`${DIR}/0300-three.md`, DOC], `${label}: the record names both`);
    const files = Object.fromEntries(
      d.source
        .state(result.head)
        .files.filter(item => item.path.startsWith(`${DIR}/`))
        .map(item => [item.path, d.source.object(item.blob).toString('utf8')]),
    );
    assert.equal(
      assembleDocument(DOC, skeleton, readerOf(files)),
      raw,
      `${label}: readers see the raw edit once`,
    );
  }
});

test('a cross-fragment raw edit keeps the composition a conflict', t => {
  const d = disk(t),
    { root, split } = sides(d);
  const other = d.source.state(root).files.find(item => item.path === 'src/other.ts');
  const across = d.state(
    [d.file(DOC, base.replace('Second, line two.\n\n## Three\n\n', 'Second and three, one line.\n')), other],
    [root],
  );
  assert.equal(resolveDocsComposition(d.source, split, across, 'Compose', at, { mainFirst: true }), null);
  assert.equal(resolveDocsComposition(d.source, across, split, 'Compose', at), null);
});

test('a non-split docs conflict is unchanged: same bytes as the keep-both rule, no extra reads', t => {
  const d = disk(t);
  const status = 'docs/status.md',
    statusBase = '# Status\n\nIntro.\n';
  // A doc with a fragment folder that both sides share (already split) is not a split conflict.
  const shared = d.file('docs/status.d/now/0100-a.md', 'Shared entry.\n');
  const root = d.state([d.file(status, statusBase), shared]);
  const main = d.state([d.file(status, '# Status\n\nIntro. Main sentence.\n'), shared], [root]);
  const lane = d.state([d.file(status, '# Status\n\nIntro. Lane sentence.\n'), shared], [root]);
  const reads = [];
  const object = d.source.object.bind(d.source);
  d.source.object = id => (reads.push(id), object(id));
  let prefetched = 0;
  d.source.prefetch = () => prefetched++;
  const result = resolveDocsComposition(d.source, lane, main, 'Compose', at, { mainFirst: true });
  assert(result);
  assert.equal(
    bytesAt(d.source, result.head, status),
    resolveMarkdownText(
      Buffer.from(statusBase),
      Buffer.from('# Status\n\nIntro. Main sentence.\n'),
      Buffer.from('# Status\n\nIntro. Lane sentence.\n'),
    ).toString('utf8'),
  );
  assert.deepEqual(result.paths, [status]);
  assert.equal(prefetched, 0, 'no split prefetch');
  assert(!reads.includes(shared.blob), 'the fragment folder is never read');
});

test('a fragment folder on one side without an Entries line is no split: the keep-both rule decides', t => {
  const d = disk(t);
  const status = 'docs/status.md',
    statusBase = '# Status\n\nIntro.\n',
    mainText = '# Status\n\nIntro. Main sentence.\n',
    laneText = '# Status\n\nIntro. Lane sentence.\n';
  const root = d.state([d.file(status, statusBase)]);
  const main = d.state([d.file(status, mainText)], [root]);
  const lane = d.state(
    [d.file(status, laneText), d.file('docs/status.d/now/0100-a.md', 'New entry.\n')],
    [root],
  );
  const result = resolveDocsComposition(d.source, lane, main, 'Compose', at, { mainFirst: true });
  assert(result);
  assert.equal(
    bytesAt(d.source, result.head, status),
    resolveMarkdownText(Buffer.from(statusBase), Buffer.from(mainText), Buffer.from(laneText)).toString(
      'utf8',
    ),
  );
  assert.deepEqual(result.paths, [status]);
});

test('hosted compose worker lands the split over a raw edit in one composition', async t => {
  const s = await composeFixture();
  const root = s.state([s.file(DOC, base), s.hidden], [s.baseline.sha256]);
  const edited = s.state([s.file(DOC, raw), s.hidden], [root.sha256]);
  const split = s.state(
    [s.file(DOC, skeleton), s.hidden, ...Object.entries(fragments).map(([path, text]) => s.file(path, text))],
    [root.sha256],
  );
  const inputs = buildComposePages([
    {
      laneId: randomUUID(),
      head: split.sha256,
      version: 0,
      sourceVersion: 0,
      lifecycleVersion: 0,
      state: { object: split, recipe: null },
    },
  ]);
  const dependencies = buildComposePages([]);
  for (const p of [...inputs.pages, ...dependencies.pages]) s.put(saveBytes(p.value));
  const output = await s.compute({
    schema: 1,
    kind: 'forge-hosted-compose-input',
    base: { head: edited.sha256, receiptId: 'main-0' },
    main: { object: edited, recipe: null },
    inputs: inputs.manifest,
    dependencies: dependencies.manifest,
    algorithm: 'forge-native-compose-v1',
    message: 'Native review composition',
    at,
  });
  const result = JSON.parse(output.manifest).result;
  assert.equal(result.status, 'clean', 'one round: no send-back');
  assert.deepEqual(result.docs, {
    paths: [`${DIR}/0300-three.md`, DOC],
    rule: 'keep both sides, main first',
  });
  const state = JSON.parse(s.objects.get(result.state.sha256));
  const text = path => s.objects.get(state.files.find(f => f.path === path).blob).toString();
  assert.equal(text(DOC), skeleton);
  assert.equal(text(`${DIR}/0300-three.md`), '## Three\n\nThird paragraph.\n\nRaw edit landed meanwhile.\n');
  assert(!output.reads.some(p => p.sha256 === s.hidden.blob), 'unrelated bytes stay unread');
});

// Review 31156e54 follow-ups: a recognised split past a bound stays a conflict (never the keep-both
// rule, which put raw text under the Entries line), only the files assembly reads are fetched, and
// an Entries folder outside NAME.d/ is a conflict.
test('a skeleton-only raw edit changes the skeleton and no fragment', t => {
  const raw = base.replace('# Guide\n', '# The guide\n');
  const result = remap(raw);
  assert(result);
  assert.equal(result.skeleton, skeleton.replace('# Guide\n', '# The guide\n'));
  assert.equal(result.fragments.size, 0);
  // Alone, that edit merges as plain text. With a fragment edit beside it the plain merge conflicts,
  // and composition puts the heading in the skeleton and the edit in its fragment.
  const both = raw.replace('Second paragraph.', 'Second paragraph, edited.');
  const d = disk(t),
    root = d.state([d.file(DOC, base)]);
  const split = d.state(
    [d.file(DOC, skeleton), ...Object.entries(fragments).map(([path, text]) => d.file(path, text))],
    [root],
  );
  const edited = d.state([d.file(DOC, both)], [root]);
  const composed = resolveDocsComposition(d.source, split, edited, 'Compose', at, { mainFirst: true });
  assert(composed);
  assert.deepEqual(composed.paths, [`${DIR}/0200-two.md`, DOC]);
  assert.equal(bytesAt(d.source, composed.head, DOC), result.skeleton);
  assert.equal(
    bytesAt(d.source, composed.head, `${DIR}/0200-two.md`),
    '## Two\n\nSecond paragraph, edited.\nSecond, line two.\n',
  );
});

test('CRLF fragments and a fragment with no final newline keep their bytes', () => {
  const crlf = Object.fromEntries(
    Object.entries(fragments).map(([path, text]) => [path, text.replace(/\n/g, '\r\n')]),
  );
  const crlfBase = assembleDocument(DOC, skeleton, readerOf(crlf));
  const crlfRaw = crlfBase.replace('Second paragraph.\r\n', 'Second paragraph, edited.\r\n');
  const one = remap(crlfRaw, { base: crlfBase, fragments: crlf });
  assert(one);
  assert.equal(
    one.fragments.get(`${DIR}/0200-two.md`),
    '## Two\r\n\r\nSecond paragraph, edited.\r\nSecond, line two.\r\n',
  );
  assert.equal(
    assembleDocument(DOC, one.skeleton, readerOf({ ...crlf, ...Object.fromEntries(one.fragments) })),
    crlfRaw,
  );
  const bare = { ...fragments, [`${DIR}/0300-three.md`]: '## Three\n\nThird paragraph.' };
  assert.equal(assembleDocument(DOC, skeleton, readerOf(bare)), base);
  const raw = base.replace('Third paragraph.\n', 'Third paragraph.\n\nThe end.\n');
  const two = remap(raw, { fragments: bare });
  assert(two);
  assert.equal(two.fragments.get(`${DIR}/0300-three.md`), '## Three\n\nThird paragraph.\n\nThe end.');
  assert.equal(
    assembleDocument(DOC, two.skeleton, readerOf({ ...bare, ...Object.fromEntries(two.fragments) })),
    raw,
  );
});

/** A split doc with `count` fragments of `size` bytes each, its pre-split text and a raw tail edit. */
function many(d, count, size = 0) {
  const files = {};
  for (let i = 0; i < count; i++)
    files[`${DIR}/${String(i).padStart(4, '0')}.md`] = `## S${i}\n\n${'x'.repeat(size)}Para ${i}.\n`;
  const old = assembleDocument(DOC, skeleton, readerOf(files));
  const root = d.state([d.file(DOC, old)]);
  const split = d.state(
    [d.file(DOC, skeleton), ...Object.entries(files).map(([path, text]) => d.file(path, text))],
    [root],
  );
  const edited = d.state([d.file(DOC, `${old}\nRaw tail.\n`)], [root]);
  return { split, edited, last: `${DIR}/${String(count - 1).padStart(4, '0')}.md` };
}

test('a split over the fragment cap stays a conflict instead of taking the keep-both rule', t => {
  const d = disk(t);
  const at500 = many(d, SPLIT_FRAGMENTS_MAX);
  const fits = resolveDocsComposition(d.source, at500.split, at500.edited, 'Compose', at, {
    mainFirst: true,
  });
  assert(fits, 'at the cap the remap runs');
  assert.match(bytesAt(d.source, fits.head, at500.last), /Raw tail\.\n$/);
  const over = many(d, SPLIT_FRAGMENTS_MAX + 1);
  for (const [lane, main] of [
    [over.split, over.edited],
    [over.edited, over.split],
  ])
    assert.equal(resolveDocsComposition(d.source, lane, main, 'Compose', at, { mainFirst: true }), null);
});

test('a split whose fragments pass the byte cap stays a conflict', t => {
  // A small old doc; the split also added sections whose fragments pass SPLIT_BYTES_MAX together.
  // The raw edit renames the first heading, far from the split's own insertion.
  const d = disk(t),
    old = '# Guide\n\n## S0\n\nIntro.\n',
    root = d.state([d.file(DOC, old)]);
  const edited = d.state([d.file(DOC, old.replace('## S0', '## S0, renamed'))], [root]);
  const compose = size => {
    const files = [
      d.file(`${DIR}/0.md`, '## S0\n\nIntro.\n'),
      ...[1, 2, 3].map(i => d.file(`${DIR}/${i}.md`, `## S${i}\n\n${'x'.repeat(size)}\n`)),
    ];
    const split = d.state([d.file(DOC, skeleton), ...files], [root]);
    return resolveDocsComposition(d.source, split, edited, 'Compose', at, { mainFirst: true });
  };
  const small = compose(10);
  assert(small, 'under the cap the remap lands');
  assert.equal(bytesAt(d.source, small.head, `${DIR}/0.md`), '## S0, renamed\n\nIntro.\n');
  assert.equal(compose(Math.ceil(SPLIT_BYTES_MAX / 3)), null);
});

test('only the .md files directly inside the Entries folders are fetched', t => {
  const d = disk(t),
    { root, split, edited } = sides(d);
  const extra = [
    d.file('docs/agents/guide.d/notes.txt', 'not an entry\n'),
    d.file(`${DIR}/deeper/0100-nested.md`, 'nested, not read by assembly\n'),
    d.file('docs/agents/guide.d/unlisted/0100-a.md', 'no Entries line names this folder\n'),
  ];
  const withExtra = d.state([...d.source.state(split).files, ...extra], [root]);
  const asked = [];
  d.source.prefetch = ids => asked.push(...ids);
  const result = resolveDocsComposition(d.source, withExtra, edited, 'Compose', at, { mainFirst: true });
  assert(result, 'the remap still lands');
  for (const file of extra) assert(!asked.includes(file.blob), `${file.path} is not fetched`);
  assert.equal(new Set(asked).size, 3 + Object.keys(fragments).length);
});

test('an Entries folder outside NAME.d/ makes the split a conflict', t => {
  const outside = `${skeleton}\nEntries: [other.d/x](other.d/x/)\n`;
  const outsideFiles = { ...fragments, 'docs/agents/other.d/x/0100-a.md': 'Outside entry.\n' };
  const old = assembleDocument(DOC, outside, readerOf(outsideFiles));
  const raw = old.replace('Third paragraph.\n', 'Third paragraph, edited.\n');
  assert.equal(remap(raw, { base: old, skeleton: outside, fragments: outsideFiles }), null);
  const d = disk(t),
    root = d.state([d.file(DOC, old)]);
  const split = d.state(
    [d.file(DOC, outside), ...Object.entries(outsideFiles).map(([path, text]) => d.file(path, text))],
    [root],
  );
  const edited = d.state([d.file(DOC, raw)], [root]);
  assert.equal(resolveDocsComposition(d.source, split, edited, 'Compose', at, { mainFirst: true }), null);
});
