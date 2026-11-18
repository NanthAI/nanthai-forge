// SPDX-License-Identifier: Apache-2.0
// Split shared documents (Item 491ddd77): nearly every Lane added a paragraph to docs/status.md, so
// its path overlapped on most landings and each overlap paid a full re-check. Entries now live one
// per file; readers see the assembled document and the shared file cannot grow entries again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENTRIES_LINE, assembleDocument } from '../dist/doc-fragments.js';
import { docsCli } from '../dist/docs-cli.js';
import { packageDocuments, readDocument, packageDocumentFragments } from '../scripts/package-documents.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

function fixture(t, files) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-doc-fragments-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(directory, path, '..'), { recursive: true });
    writeFileSync(join(directory, path), text);
  }
  return directory;
}

test('a split document assembles its entries in file-name order with links relative to the document', t => {
  const directory = fixture(t, {
    'docs/guide.md':
      '# Guide\n\nEntries: [guide.d/now](guide.d/now/)\n\n## Later\n\nEntries: [guide.d/later](guide.d/later/)\n',
    'docs/guide.d/now/0020-second.md':
      'Second, see [the queue](../../queue.md#order) and [code](../../../src/a.ts).\n',
    'docs/guide.d/now/0010-first.md':
      'First [anchor](#later), [site](https://example.com) and [folder](../../ops/).\n',
    'docs/guide.d/later/0010-only.md': '- Only [self](../../guide.md#later).\n',
  });
  assert.equal(
    readDocument(directory, 'docs/guide.md'),
    '# Guide\n\nFirst [anchor](#later), [site](https://example.com) and [folder](ops/).\n\n' +
      'Second, see [the queue](queue.md#order) and [code](../src/a.ts).\n\n## Later\n\n- Only [self](guide.md#later).\n',
  );
  assert.deepEqual(packageDocumentFragments(directory, ['docs/guide.md']), [
    'docs/guide.d/later/0010-only.md',
    'docs/guide.d/now/0010-first.md',
    'docs/guide.d/now/0020-second.md',
  ]);
  const plain = '# Plain\n\nEntries are not a line of their own here.\n';
  assert.equal(
    assembleDocument('docs/plain.md', plain, {
      list: () => assert.fail('no folder read'),
      read: () => '',
    }),
    plain,
  );
});

test('split shared documents hold only headings and entries lines, so new entries get their own file', () => {
  const raw = path => readFileSync(join(root, path), 'utf8');
  const split = packageDocuments.filter(path =>
    raw(path)
      .split('\n')
      .some(line => ENTRIES_LINE.test(line)),
  );
  assert.ok(split.includes('docs/status.md'), 'docs/status.md is split into docs/status.d/');
  assert.ok(split.includes('docs/security.md'), 'docs/security.md is split into docs/security.d/sections/');
  for (const path of split) {
    for (const block of raw(path)
      .trimEnd()
      .split(/\n{2,}/))
      assert.ok(
        block.startsWith('#') || ENTRIES_LINE.test(block),
        `${path} gained an entry in the shared file: "${block.slice(0, 80)}". Put it in its own file in the section's ` +
          `folder instead (for example ${path.replace(/\.md$/, '.d')}/<section>/0105-short-name.md); the number only orders the assembled page.`,
      );
  }
});

test('nforge docs prints a split document assembled and does not list its entry files', async () => {
  const printed = await output(() => docsCli(['status']));
  assert.equal(printed, readDocument(root, 'docs/status.md'));
  assert.match(printed, /^## Works\n\n(?!Entries: )\S/m);
  assert.doesNotMatch(printed, /^Entries: \[/m);
  const listing = await output(() => docsCli([]));
  assert.match(listing, /^docs\/status\.md$/m);
  assert.doesNotMatch(listing, /status\.d\//);
});

async function output(run) {
  const write = process.stdout.write;
  let text = '';
  process.stdout.write = chunk => ((text += chunk), true);
  try {
    await run();
  } finally {
    process.stdout.write = write;
  }
  return text;
}
