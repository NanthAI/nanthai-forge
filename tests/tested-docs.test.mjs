// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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
      rule: 'name-mention-v2',
      paths: ['AGENTS.md', 'docs/agents/workflow.md', 'docs/ci.md', 'docs/status.md'],
    },
  );
  // Case-insensitive file names: doubt means tested.
  files.set('src/x.ts', "const doc = 'readme.md';");
  assert.ok(testedDocs(files.keys(), path => files.get(path)).paths.includes('plans/Readme.MD'));
});

test('a Markdown file read by Go, Rust or Python source or a shell script is tested, not only JS', () => {
  const files = new Map([
    ['docs/a.md', '#'],
    ['docs/b.md', '#'],
    ['docs/c.md', '#'],
    ['docs/d.md', '#'],
    ['docs/e.md', '#'],
    ['docs/prose.md', '#'],
    ['cmd/x_test.go', 'os.ReadFile("../docs/a.md")'],
    ['src/lib.rs', 'include_str!("../docs/b.md")'],
    ['tests/test_x.py', "open('docs/c.md')"],
    ['scripts/check.sh', 'cat docs/d.md'],
    ['scripts/check-docs', '#!/usr/bin/env bash\ncat docs/e.md'],
    ['Makefile', 'cat docs/prose.md'],
  ]);
  assert.deepEqual(testedDocs(files.keys(), path => files.get(path)).paths, [
    'docs/a.md',
    'docs/b.md',
    'docs/c.md',
    'docs/d.md',
    'docs/e.md',
  ]);
});

test('the pinned list is trusted only in its exact rule and shape; otherwise every Markdown is tested', () => {
  // A list from the previous scanner (JS-only readers) may omit documents: it falls back to every Markdown.
  assert.equal(pinnedTestedDocs({ testedDocs: { rule: 'name-mention-v1', paths: [] } }), undefined);
  assert.deepEqual(
    [...pinnedTestedDocs({ testedDocs: { rule: 'name-mention-v2', paths: ['AGENTS.md'] } })],
    ['AGENTS.md'],
  );
  for (const selection of [
    null,
    { scope: 'full' },
    { testedDocs: { rule: 'other', paths: [] } },
    { testedDocs: { rule: 'name-mention-v2', paths: 'AGENTS.md' } },
    { testedDocs: { rule: 'name-mention-v2', paths: [1] } },
    { testedDocs: { rule: 'name-mention-v2', paths: Array(TESTED_DOCS_MAX + 1).fill('a.md') } },
  ])
    assert.equal(pinnedTestedDocs(selection), undefined, JSON.stringify(selection)?.slice(0, 80));
});

test('a repository without Markdown pins an empty list', () => {
  assert.deepEqual(
    testedDocs(['src/a.ts'], () => ''),
    { rule: 'name-mention-v2', paths: [] },
  );
});
