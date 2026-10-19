// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { posix } from 'node:path';
import { localPathFindings } from '../scripts/check-local-paths.mjs';

const home = kind => posix.join('/', kind, 'synthetic-user', 'project', 'file.txt');
const findings = (path, text) => localPathFindings(path, Buffer.from(text));
const marker = '// forge-path-fixture: synthetic';

test('home paths fail in arbitrary source text without exposing their contents', () => {
  for (const kind of ['Users', 'home']) {
    const result = findings('docs/example.md', `Example\n${home(kind)}\n`);
    assert.equal(result.length, 1);
    assert.match(result[0], /^docs\/example.md:2:/);
    assert.ok(!result[0].includes('synthetic-user'));
  }
  assert.equal(findings('package.json', JSON.stringify({ path: home('Users') })).length, 1);
  assert.equal(findings('README.md', posix.join('/', 'home', '名前', 'project') + '/').length, 1);
});

test('relative paths, placeholders and binary files are permitted', () => {
  assert.deepEqual(findings('docs/example.md', '~/project/file\n$FORGE_OWNER/file\n<workspace>/file'), []);
  assert.deepEqual(localPathFindings('image.bin', Buffer.from([0, ...Buffer.from(home('Users'))])), []);
  assert.deepEqual(localPathFindings('image.bin', Buffer.from([255, ...Buffer.from(home('home'))])), []);
});

test('only explicitly marked synthetic test lines are allowlisted', () => {
  const text = `${marker}\n${home('Users')}\n${home('home')}\n`;
  for (const path of ['tests/example.test.mjs', 'tests/fixtures/example.txt']) {
    const result = findings(path, text);
    assert.equal(result.length, 1);
    assert.match(result[0], /:3:/);
    assert.equal(findings(path, home('Users')).length, 1);
    assert.equal(findings(path, `${marker}\n\n${home('Users')}`).length, 1);
  }
  assert.equal(findings('docs/example.md', text).length, 2);
  assert.equal(findings('src/example.ts', text).length, 2);
  assert.equal(findings('tests/helper.mjs', text).length, 2);
});
