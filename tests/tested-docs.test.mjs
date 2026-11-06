// SPDX-License-Identifier: Apache-2.0
// Markdown a test or script reads stays on the recheck path (Issue 7fe54c7c).
import test from 'node:test';
import assert from 'node:assert/strict';
import { testedDocs, pinnedTestedDocs, TESTED_DOCS_MAX } from '../dist/tested-docs.js';

test('a Markdown file is tested when code, JSON or YAML names it, by path or file name', () => {
  const files = new Map([
    ['AGENTS.md', '# rules'],
    ['docs/agents/workflow.md', '# workflow'],
    ['docs/status.md', '# status'],
    ['docs/prose.md', '# prose'],
    ['plans/Readme.MD', '# plan'],
    ['tests/help.test.mjs', "readFileSync(new URL('../docs/agents/workflow.md', import.meta.url))"],
    ['tests/fixture.test.mjs', "for (const file of ['status.md']) write(join(root, 'docs', file));"],
    ['scripts/package-documents/agents.json', '{"path":"AGENTS.md"}'],
    ['docs/ci.md', '# ci'],
    ['.github/workflows/x.yml', 'run: cat docs/ci.md'],
    ['docs/links.md', 'See [prose](prose.md).'],
    ['web/logo.png', 'binary mention docs/prose.md'],
  ]);
  assert.deepEqual(
    testedDocs(files.keys(), path => files.get(path)),
    {
      rule: 'name-mention-v1',
      paths: ['AGENTS.md', 'docs/agents/workflow.md', 'docs/ci.md', 'docs/status.md'],
    },
  );
  // Case-insensitive file names: doubt means tested.
  files.set('src/x.ts', "const doc = 'readme.md';");
  assert.ok(testedDocs(files.keys(), path => files.get(path)).paths.includes('plans/Readme.MD'));
});

test('the pinned list is trusted only in its exact rule and shape; otherwise every Markdown is tested', () => {
  assert.deepEqual(
    [...pinnedTestedDocs({ testedDocs: { rule: 'name-mention-v1', paths: ['AGENTS.md'] } })],
    ['AGENTS.md'],
  );
  for (const selection of [
    null,
    { scope: 'full' },
    { testedDocs: { rule: 'other', paths: [] } },
    { testedDocs: { rule: 'name-mention-v1', paths: 'AGENTS.md' } },
    { testedDocs: { rule: 'name-mention-v1', paths: [1] } },
    { testedDocs: { rule: 'name-mention-v1', paths: Array(TESTED_DOCS_MAX + 1).fill('a.md') } },
  ])
    assert.equal(pinnedTestedDocs(selection), undefined, JSON.stringify(selection)?.slice(0, 80));
});

test('a repository without Markdown pins an empty list', () => {
  assert.deepEqual(
    testedDocs(['src/a.ts'], () => ''),
    { rule: 'name-mention-v1', paths: [] },
  );
});
