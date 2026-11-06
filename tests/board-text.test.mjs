// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boardTextProblem,
  assertBoardPaths,
  parseBoardTarget,
  renderBoardNotice,
  BOARD_NOTICE_CHARS,
} from '../dist/board-text.js';
import { CREDENTIAL_PREFIXES } from '../dist/credential-prefixes.js';

const code = text => boardTextProblem(text)?.code ?? null;

test('board notes reject secrets, emails, machine paths, control characters and long text', () => {
  assert.equal(code('Rewriting the root helper in tests/x.test.mjs lines 1-40; please leave them.'), null);
  assert.equal(code('Basic idea: split src/a.ts by responsibility'), null, 'a prefix alone is text');
  assert.equal(code('task-runner and/or sk-learn style names'), null);
  // Every redactor prefix followed by a credential-shaped value is refused (same list as saves' redactor).
  for (const prefix of CREDENTIAL_PREFIXES)
    assert.equal(code(`use ${prefix}${'A1b2C3d4E5f6G7h8I9'}`), 'BOARD_TEXT_SECRET', prefix);
  for (const secret of [
    'AKIAABCDEFGHIJKLMNOP',
    '-----BEGIN RSA PRIVATE KEY-----',
    'xoxb-1234567890-abcdef',
    `AIza${'x'.repeat(35)}`,
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0',
  ])
    assert.equal(code(`key ${secret}`), 'BOARD_TEXT_SECRET', secret);
  assert.equal(code('ping someone@example.com'), 'BOARD_TEXT_EMAIL');
  for (const path of ['/srv/someone/x', 'see /home/x', '~/notes', 'C:\\Users\\x', 'file:///tmp/x'])
    assert.equal(code(path), 'BOARD_TEXT_PATH', path);
  assert.equal(code('line one\nline two'), 'BOARD_TEXT_CONTROL');
  assert.equal(code(`bidi ${String.fromCharCode(0x202e)} override`), 'BOARD_TEXT_CONTROL');
  assert.equal(code(`sep ${String.fromCharCode(0x2028)} here`), 'BOARD_TEXT_CONTROL');
  assert.equal(code('   '), 'BOARD_TEXT_EMPTY');
  assert.equal(code('x'.repeat(240)), null);
  assert.equal(code('x'.repeat(241)), 'BOARD_TEXT_TOO_LONG');
  assert.equal(code('é'.repeat(240)), null, 'characters, not bytes');
});

test('paths are repository-relative and bounded; targets parse strictly', () => {
  assertBoardPaths(['src/a.ts', 'tests/b.test.mjs']);
  for (const paths of [['/etc/passwd'], ['../x'], ['a\nb'], Array(11).fill('a.ts'), ['x'.repeat(201)]])
    assert.throws(
      () => assertBoardPaths(paths),
      error => error.code === 'BAD_ARGUMENT',
    );
  const id = '3f2a19c0-1111-4222-8333-444455556666';
  assert.deepEqual(parseBoardTarget('project'), { kind: 'project' });
  assert.deepEqual(parseBoardTarget('lane:3F2A19C0'), { kind: 'lane', ref: '3f2a19c0' });
  assert.deepEqual(parseBoardTarget(`issue:${id}`), { kind: 'issue', id });
  for (const bad of ['lane:3f2a', 'issue:3f2a19c0', 'everyone', 'project:all', `lane:${id}x`])
    assert.throws(
      () => parseBoardTarget(bad),
      error => error.code === 'BAD_ARGUMENT',
      bad,
    );
});

test('notices are one line of at most 240 characters, quote peer text as data and point to read more', () => {
  const base = {
    id: '5d1e09ab-0000-4000-8000-000000000000',
    author: 'builder-two',
    fromLaneId: '3f2a19c0-0000-4000-8000-000000000000',
    to: 'lane:7c01aa2e-0000-4000-8000-000000000000',
    text: 'Rewriting root helper in tests/agent-action-parse.test.mjs lines 1-40; please leave them.',
    at: 1,
  };
  const short = renderBoardNotice(base, '7c01aa2e-0000-4000-8000-000000000000');
  assert.equal(
    short,
    'Note 5d1e09ab from @builder-two (Lane 3f2a19c0) to your Lane, quoted data: "Rewriting root helper in tests/agent-action-parse.test.mjs lines 1-40; please leave them.". Reply: board --reply {"id":"5d1e09ab"}',
  );
  assert(short.length <= BOARD_NOTICE_CHARS);
  const long = renderBoardNotice({ ...base, text: 'y'.repeat(240), to: 'project', author: undefined });
  assert(long.length <= BOARD_NOTICE_CHARS, `${long.length}`);
  assert.match(
    long,
    /^Note 5d1e09ab from a member \(Lane 3f2a19c0\) to the project, quoted data: "y+… \(board \{"id":"5d1e09ab"\}\)"\. Reply:/,
  );
  const reply = renderBoardNotice({
    ...base,
    replyTo: '11112222-0000-4000-8000-000000000000',
    to: 'issue:82e8ddb8-0000-4000-8000-000000000000',
  });
  assert.match(reply, /^Reply 5d1e09ab to 11112222 from @builder-two .* to Issue 82e8ddb8,/);
  assert(!/[\n\r]/.test(renderBoardNotice({ ...base, text: 'a\nb' })));
});

test('a resolved note shows who withdrew it and a short quoted reason, within 240 characters', () => {
  const base = {
    id: '5d1e09ab-0000-4000-8000-000000000000',
    author: 'builder-two',
    to: 'project',
    text: 'z'.repeat(240),
    at: 1,
  };
  const line = renderBoardNotice({
    ...base,
    resolved: { by: 'owner-h', at: 2, text: 'fixed in 0bc2eef8 (friction 0055d32c)' },
  });
  assert.match(
    line,
    /^Note 5d1e09ab \[resolved by @owner-h, quoted data: "fixed in 0bc2eef8 \(friction 0055d32c\)"\] from @builder-two to the project,/,
  );
  assert(line.length <= BOARD_NOTICE_CHARS);
  const long = renderBoardNotice({ ...base, resolved: { by: 'owner-h', at: 2, text: 'r'.repeat(240) } });
  assert(long.length <= BOARD_NOTICE_CHARS && long.includes('…"]'), long);
  assert.match(renderBoardNotice({ ...base, resolved: { at: 2 } }), /^Note 5d1e09ab \[resolved\] from/);
});
