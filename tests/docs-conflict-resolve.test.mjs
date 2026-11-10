// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { conflictRule, resolveListText, resolveMarkdownText } from '../dist/native-docs-resolve.js';
import { declaredMergePaths } from '../dist/project-config.js';
import { mergeNativeText } from '../dist/native-text-merge.js';

// Each fixture selects its own scope, independent of the outer check runner.
for (const name of ['FORGE_CHECK_FULL', 'FORGE_CHECK_SCOPED', 'FORGE_CHECK_INTERACTION'])
  Reflect.deleteProperty(process.env, name);

const text = lines => Buffer.from(lines.map(line => `${line}\n`).join(''));
const resolveText = (base, main, lane) =>
  resolveMarkdownText(text(base), text(main), text(lane))?.toString('utf8') ?? null;
const items = Array.from({ length: 12 }, (_, i) => `- item ${i}`);
const insert = (at, ...added) => [...items.slice(0, at), ...added, ...items.slice(at)];

test('Markdown resolution keeps both sides deterministically, main first', () => {
  // Both sides insert at one point: union, main first, no markers.
  const both = resolveText(items, insert(6, '- main a', '- main b'), insert(6, '- lane a'));
  assert.equal(both, text(insert(6, '- main a', '- main b', '- lane a')).toString());
  // Replacement plus an insertion at its boundary keeps both.
  const prose = ['# Title', '', 'Para one.', 'Para two.', ''];
  assert.equal(
    resolveText(
      prose,
      ['# Title', '', 'Para one, edited.', 'Para two.', ''],
      [...prose.slice(0, 3), 'Lane line.', ...prose.slice(3)],
    ),
    text(['# Title', '', 'Para one, edited.', 'Lane line.', 'Para two.', '']).toString(),
  );
  // Overlapping list edits: both new rows survive, removed base rows stay removed.
  const main = items.map(line => (line === '- item 4' ? '- item 4 (main)' : line));
  const lane = items.map(line => (line === '- item 4' ? '- item 4 (lane)' : line));
  const list = resolveText(items, main, lane);
  assert.match(list, /- item 4 \(main\)\n- item 4 \(lane\)\n/);
  assert.doesNotMatch(list, /- item 4\n/);
  const table = ['| a | b |', '| - | - |', '| 1 | 2 |'];
  assert.equal(
    resolveText(table, ['| a | b |', '| - | - |', '| 1 | 3 |'], ['| a | b |', '| - | - |', '| 1 | 4 |']),
    text(['| a | b |', '| - | - |', '| 1 | 3 |', '| 1 | 4 |']).toString(),
  );
  // Identical edits are not duplicated.
  assert.equal(
    resolveText(items, insert(3, '- same'), insert(3, '- same')),
    text(insert(3, '- same')).toString(),
  );
  // Deterministic: same input, same bytes.
  assert.equal(resolveText(items, main, lane), list);
  // Both sides append a sentence to one prose line (Issue 561996ac): the line, main's, the Lane's.
  const para = ['# Status', '', 'Intro.', ''];
  const appended = side => ['# Status', '', `Intro. ${side} sentence.`, ''];
  assert.equal(
    resolveText(para, appended('Main'), appended('Lane')),
    text(['# Status', '', 'Intro. Main sentence. Lane sentence.', '']).toString(),
  );
  assert.equal(
    resolveMarkdownText(
      Buffer.from('Intro.'),
      Buffer.from('Intro. Main.'),
      Buffer.from('Intro. Lane.'),
    )?.toString(),
    'Intro. Main. Lane.',
    'no final newline is added',
  );
  // A rewritten start, or a second edited line in the same hunk, stays a conflict.
  assert.equal(resolveText(['Intro here.'], ['Intro there. Main.'], ['Intro here. Lane.']), null);
  assert.equal(resolveText(['Intro.', 'Two.'], ['Intro. Main.', 'Two!'], ['Intro. Lane.', 'Two.']), null);
  // Ambiguous: prose modified differently on both sides, or an insertion inside a replaced range.
  assert.equal(
    resolveText(prose, ['# Title', '', 'Main.', 'Para two.', ''], ['# Title', '', 'Lane.', 'Para two.', '']),
    null,
  );
  assert.equal(resolveText(['a', 'b', 'c', 'd'], ['a', 'X', 'Y', 'd'], ['a', 'b', 'lane', 'c', 'd']), null);
  // A side without a final newline never joins two lines.
  assert.equal(
    resolveMarkdownText(Buffer.from('a\n'), Buffer.from('a\nmain'), Buffer.from('a\nlane')).toString(),
    'a\nmain\nlane',
  );
  assert.equal(resolveMarkdownText(Buffer.from('a\n'), Buffer.from([0, 1]), Buffer.from('a\n')), null);
});

// Issue aa9fb5b1 (no-merge paths): a forge.json `merge` list keeps both sides' entries where the
// line merge stops; `fragments` keeps multi-line entries whole.
test('declared list rules merge shared lists that the line merge refuses', () => {
  const list = (base, main, lane, rule) => {
    assert.equal(mergeNativeText(Buffer.from(base), Buffer.from(main), Buffer.from(lane)), null);
    return resolveListText(Buffer.from(base), Buffer.from(main), Buffer.from(lane), rule)?.toString() ?? null;
  };
  // Two entries added at one point where one name starts with the other.
  assert.equal(
    list('alpha\nzeta\n', 'alpha\nbilling\nzeta\n', 'alpha\nbilling-export\nzeta\n', 'union'),
    'alpha\nbilling\nbilling-export\nzeta\n',
  );
  // Both append to a last line without a newline: the shared line once, then main's, then the Lane's.
  assert.equal(list('a\nb', 'a\nb\nc', 'a\nb\nd', 'union'), 'a\nb\nc\nd');
  // Both replace one entry: both replacements, the old entry removed.
  assert.equal(list('a\nb\nc\n', 'a\nB1\nc\n', 'a\nB2\nc\n', 'union'), 'a\nB1\nB2\nc\n');
  // Fragments: each blank-line block is one entry, so two changelog sections stay whole.
  const log = '# Log\n\n## 1.0\n- x\n',
    section = who => `# Log\n\n## Next\n- ${who} thing\n\n## 1.0\n- x\n`;
  assert.equal(
    list(log, section('main'), section('lane'), 'fragments'),
    '# Log\n\n## Next\n- main thing\n\n## Next\n- lane thing\n\n## 1.0\n- x\n',
  );
  assert.equal(resolveListText(Buffer.from('a\n'), Buffer.from([0, 1]), Buffer.from('b\n'), 'union'), null);
  // forge.json: fragments win over union, Markdown docs keep their rule, nothing else qualifies.
  const declared = declaredMergePaths(
    JSON.stringify({
      merge: { union: ['lists/*.txt', 'packages/**'], fragments: ['packages/*/CHANGELOG.md'] },
    }),
  );
  assert.equal(conflictRule('lists/features.txt', declared), 'union');
  assert.equal(conflictRule('packages/web/CHANGELOG.md', declared), 'fragments');
  assert.equal(conflictRule('docs/guide.md', declared), 'docs');
  assert.equal(conflictRule('src/x.ts', declared), undefined);
  // A malformed file or value declares nothing; merging never throws over it.
  for (const text of ['{', '[]', '{"merge":{"union":["/abs"]}}', '{"merge":{"union":"x"}}'])
    assert.deepEqual(declaredMergePaths(text), { union: [], fragments: [] }, text);
});
