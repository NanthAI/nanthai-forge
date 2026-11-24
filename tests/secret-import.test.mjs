// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item 41a0df87 slice 3 (owner decision 4): `nforge secret import` seals a .env into Development in batched head
// writes against the real sealed Convex module, keeps .env.example listing the names only, removes the plaintext
// after a full import (kept otherwise, with the reason) and prints the undo, which writes the file back for a person.
// An agent's import of a name that exists or existed is a proposal. Synthetic values only.
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { setup } from './helpers/sealed-hosted.mjs';
import { SealedClient } from '../dist/sealed-client.js';
import { SealedJournal } from '../dist/sealed-journal.js';
import { importDotenv, restoreDotenv } from '../dist/secret-import.js';
import { dotenvLine, parseDotenv, readDotenvFile, removeIfUnchanged } from '../dist/secret-dotenv.js';

const code = expected => error => (error.code ?? error.data?.code) === expected;
const clear = result => {
  result?.key?.fill(0);
  for (const secret of result?.secrets ?? []) secret.value.fill(0);
};
async function values(client) {
  const read = await client.read();
  try {
    return Object.fromEntries((read?.secrets ?? []).map(s => [s.name, s.value.toString()]));
  } finally {
    clear(read);
  }
}
function project(t) {
  const h = setup(t);
  h.root = join(h.directory, 'tree');
  mkdirSync(h.root);
  h.env = join(h.root, '.env');
  h.example = join(h.root, '.env.example');
  h.writes = () => h.calls.filter(c => c.action === 'write').length;
  h.reads = () => h.calls.filter(c => c.action === 'read').length;
  h.agent = new SealedClient(h.project, h.account, h.keys, h.pins, h.transport, true);
  return h;
}
const run = (h, client = h.client, options = {}) =>
  importDotenv(client, h.root, options.file, { keep: false, cwd: h.root, ...options });
const leaks = (lines, ...secrets) => secrets.some(secret => lines.join('\n').includes(secret));

test('a .env is sealed in one write, .env.example gains its names only, and the plaintext goes with its undo', async t => {
  const h = project(t);
  writeFileSync(
    h.env,
    [
      '# synthetic',
      'API_TOKEN=synthetic-api-value # trailing comment',
      'export DATABASE_URL="postgres://synthetic\\nsecond-line"',
      "QUOTED='literal #not-a-comment'",
      'MULTI="first',
      'second"',
      'EMPTY=',
      '',
    ].join('\n'),
  );
  writeFileSync(h.example, '# names\nAPI_TOKEN=\n');
  const lines = await run(h);
  assert.deepEqual([h.reads(), h.writes()], [1, 1], 'one read and one write for the whole file');
  assert.deepEqual(await values(h.client), {
    API_TOKEN: 'synthetic-api-value',
    DATABASE_URL: 'postgres://synthetic\nsecond-line',
    QUOTED: 'literal #not-a-comment',
    MULTI: 'first\nsecond',
    EMPTY: '',
  });
  assert.equal(
    readFileSync(h.example, 'utf8'),
    '# names\nAPI_TOKEN=\nDATABASE_URL=\nQUOTED=\nMULTI=\nEMPTY=\n',
  );
  assert(!existsSync(h.env), 'the plaintext is removed');
  assert.match(
    lines.at(-1),
    /^Removed \.env; .* Undo: nforge secret import --restore \(a person, on a terminal\)\.$/,
  );
  assert(!leaks(lines, 'synthetic-api-value', 'postgres://', 'literal'), 'output names, never values');
  // The undo writes the file back, private, and it imports to the same values with nothing to write.
  const restored = await restoreDotenv(h.client, h.root, undefined, h.root);
  assert.match(restored[0], /^Wrote \.env \(private to you\) with 5 names from Development\.$/);
  assert.equal(statSync(h.env).mode & 0o777, 0o600);
  const before = h.writes();
  const again = await run(h);
  assert.equal(h.writes(), before, 'unchanged values are not written again');
  assert.match(
    again.join('\n'),
    /Already in Development, unchanged: API_TOKEN, DATABASE_URL, QUOTED, MULTI, EMPTY/,
  );
  assert(!existsSync(h.env));
  // Restoring over an existing file writes nothing; an agent never restores.
  writeFileSync(h.env, 'KEEP=me\n');
  await assert.rejects(restoreDotenv(h.client, h.root, undefined, h.root), code('UNSAFE_PATH'));
  assert.equal(readFileSync(h.env, 'utf8'), 'KEEP=me\n');
  await assert.rejects(restoreDotenv(h.agent, h.root, 'other.env', h.root), code('PERSON_REQUIRED'));
  assert(!existsSync(join(h.root, 'other.env')));
});

test('the file is kept, with the reason, when anything was not imported or the person asks', async t => {
  const h = project(t);
  writeFileSync(h.env, 'GOOD_TOKEN=synthetic-good\nPATH=/synthetic\nnot a declaration\nlower_name=x\n');
  const lines = await run(h);
  assert.deepEqual(await values(h.client), { GOOD_TOKEN: 'synthetic-good' });
  assert.match(
    lines.join('\n'),
    /Not imported: line 3 \(not a NAME=value line\), PATH \(denied name\), line 4 \(invalid name\)\./,
  );
  assert.match(lines.at(-1), /^Kept \.env: some lines were not imported\.$/);
  assert(!leaks(lines, '/synthetic', 'synthetic-good'));
  writeFileSync(h.env, 'GOOD_TOKEN=synthetic-good\n');
  assert.match((await run(h, h.client, { keep: true })).at(-1), /^Kept \.env: you asked to keep it\.$/);
  assert(existsSync(h.env));
  // A link is never followed.
  symlinkSync(h.env, join(h.root, 'linked.env'));
  await assert.rejects(run(h, h.client, { file: 'linked.env' }), code('UNSAFE_PATH'));
});

test('a case-variant .env.example is refused before anything is written, never overwritten', async t => {
  const h = project(t);
  rmSync(h.example, { force: true });
  writeFileSync(join(h.root, '.ENV.EXAMPLE'), 'KEPT_NAME=\n');
  writeFileSync(h.env, 'GOOD_TOKEN=synthetic-good\n');
  await assert.rejects(run(h), code('UNSAFE_PATH'));
  assert.equal(h.writes(), 0);
  assert.equal(readFileSync(join(h.root, '.ENV.EXAMPLE'), 'utf8'), 'KEPT_NAME=\n');
  assert(existsSync(h.env));
});

test('an agent adds new names and proposes the ones that exist or existed; the file stays while they wait', async t => {
  const h = project(t);
  await h.client.write('EXISTING_TOKEN', Buffer.from('person-synthetic-value'));
  await h.client.write('REMOVED_TOKEN', Buffer.from('person-removed-value'));
  await h.client.write('REMOVED_TOKEN', null);
  writeFileSync(
    h.env,
    'NEW_TOKEN=agent-new-value\nEXISTING_TOKEN=agent-changed-value\nREMOVED_TOKEN=agent-readded\nPIP_INDEX_URL=https://synthetic.invalid\n',
  );
  const lines = await run(h, h.agent);
  assert.deepEqual(await values(h.client), {
    EXISTING_TOKEN: 'person-synthetic-value',
    NEW_TOKEN: 'agent-new-value',
  });
  const waiting = [...h.s.tables.sealedSecretSets.values()].find(s => s.kind === 1).proposals;
  assert.deepEqual(waiting.map(p => p.name).sort(), ['EXISTING_TOKEN', 'REMOVED_TOKEN']);
  const text = lines.join('\n');
  assert.match(text, /Imported into Development: NEW_TOKEN\./);
  assert.match(
    text,
    /Proposed for a person, since they exist or existed in Development: EXISTING_TOKEN, REMOVED_TOKEN/,
  );
  assert.match(text, /PIP_INDEX_URL \(a person imports a routing name\)/);
  assert.match(lines.at(-1), /^Kept \.env: /);
  assert.equal(readFileSync(h.example, 'utf8'), 'NEW_TOKEN=\nEXISTING_TOKEN=\nREMOVED_TOKEN=\n');
  assert(!leaks(lines, 'agent-new-value', 'agent-changed-value', 'agent-readded'));
});

test('a large .env splits into writes of 90 names within the server work cap', async t => {
  const h = project(t);
  const names = Array.from({ length: 150 }, (_, i) => `SYNTHETIC_${String(i).padStart(3, '0')}`);
  writeFileSync(h.env, names.map(n => `${n}=value-${n.toLowerCase()}`).join('\n'));
  await run(h);
  assert.equal(h.writes(), 2);
  assert.equal(Object.keys(await values(h.client)).length, 150);
  assert(!existsSync(h.env));
});

test('dotenv forms round-trip: every line restore writes parses back to the same bytes', () => {
  // Review L3: a carriage return, alone or before a line feed, comes back as itself.
  const forms = [
    'plain',
    "it's",
    "both ' and `",
    'line\nbreak',
    '  spaced  ',
    '#hash',
    '',
    'a\r\nb',
    'lone\rcr',
    "q' \r",
  ];
  for (const value of forms) {
    const line = dotenvLine('NAME', value);
    assert(line && !line.includes('\r'), JSON.stringify(value));
    assert.equal(parseDotenv(`${line}\n`).entries[0].value.toString(), value, line);
  }
  assert.equal(dotenvLine('NAME', `' \` "\n`), null);
  assert.equal(dotenvLine('NAME', '"\r'), null);
  const parsed = parseDotenv('A=1\nA=2\nB="open\n');
  assert.equal(parsed.entries.find(e => e.name === 'A').value.toString(), '2');
  assert.deepEqual(
    parsed.notices.map(n => `${n.name} (${n.reason})`),
    ['A (repeated; the last value is used)', 'line 3 (unclosed or malformed quote)'],
  );
});

test('review M1: an agent gets the same outcome, output and file for a right and a wrong guess of a stored value', async t => {
  const h = project(t);
  await h.client.write('EXISTING_TOKEN', Buffer.from('person-synthetic-value'));
  writeFileSync(h.example, 'EXISTING_TOKEN=\n');
  const outcome = async guess => {
    writeFileSync(h.env, `EXISTING_TOKEN=${guess}\n`);
    const before = h.writes();
    const lines = await run(h, h.agent);
    const waiting = [...h.s.tables.sealedSecretSets.values()].find(s => s.kind === 1).proposals ?? [];
    return { lines, wrote: h.writes() - before, kept: existsSync(h.env), waiting: waiting.map(p => p.name) };
  };
  const right = await outcome('person-synthetic-value');
  const wrong = await outcome('agent-wrong-guess');
  assert.deepEqual(right, wrong);
  assert.deepEqual(right.lines, [
    'Proposed for a person, since they exist or existed in Development: EXISTING_TOKEN (nforge secret proposals).',
    'Kept .env: proposals wait for a person.',
  ]);
  assert.deepEqual([right.wrote, right.kept, right.waiting], [0, true, ['EXISTING_TOKEN']]);
  assert.deepEqual(await values(h.client), { EXISTING_TOKEN: 'person-synthetic-value' });
});

test('review M2 and L1: a line that is not UTF-8 or not well formed is named by number only, and the file stays', async t => {
  const h = project(t);
  writeFileSync(
    h.env,
    Buffer.concat([
      Buffer.from('GOOD_TOKEN=synthetic-good\nLATIN_TOKEN=ab'),
      Buffer.from([0xe9, 0xff]),
      Buffer.from('cd\nhttps://demo:FAKEPASS123@host/?a=b\nQUOTE_TOKEN="FAKEOPEN123\n'),
    ]),
  );
  const lines = await run(h);
  assert.deepEqual(await values(h.client), { GOOD_TOKEN: 'synthetic-good' });
  assert.match(
    lines.join('\n'),
    /Not imported: line 2 \(not valid UTF-8\), line 4 \(unclosed or malformed quote\), line 3 \(invalid name\)\./,
  );
  assert.match(lines.at(-1), /^Kept \.env: some lines were not imported\.$/);
  assert(!leaks(lines, 'FAKEPASS123', 'demo', 'host', 'FAKEOPEN123', 'LATIN_TOKEN'));
});

test(
  'review L2: parsing is linear up to the 1 MiB cap, and a larger file is refused',
  { timeout: 10_000 },
  async t => {
    const cap = 1024 * 1024;
    // Each continued quote used to rescan everything before it: minutes at the cap.
    const unclosed = `A="${'x\n'.repeat((cap - 4) / 2)}`;
    const { entries, notices } = parseDotenv(unclosed);
    // The open quote is named once; every later line is then read as its own, malformed, line.
    assert.equal(entries.length, 0);
    assert.equal(`${notices[0].name} (${notices[0].reason})`, 'line 1 (unclosed or malformed quote)');
    assert.equal(notices.length, (cap - 4) / 2);
    const openers = Array.from(
      { length: cap / 16 },
      (_, i) => `N${String(i).padStart(9, '0')}=${'\'"`'[i % 3]}x\n`,
    ).join('');
    assert(openers.length <= cap);
    parseDotenv(openers);
    assert.throws(() => parseDotenv('x'.repeat(cap + 1)), code('SECRETS_FORMAT_REFUSED'));
    const h = project(t);
    writeFileSync(h.env, Buffer.alloc(cap + 1, 0x41));
    assert.throws(() => readDotenvFile(h.env), code('SECRETS_FORMAT_REFUSED'));
  },
);

test('removal deletes only the file that was imported, never one swapped in after the read', async t => {
  const h = project(t);
  writeFileSync(h.env, 'A_TOKEN=one\n');
  const read = readDotenvFile(h.env);
  renameSync(h.env, join(h.root, 'moved.env'));
  writeFileSync(h.env, 'A_TOKEN=one\n'); // same bytes, another file
  assert.equal(removeIfUnchanged(h.env, read), 'changed');
  assert.equal(readFileSync(h.env, 'utf8'), 'A_TOKEN=one\n');
  const fresh = readDotenvFile(h.env);
  writeFileSync(h.env, 'A_TOKEN=two\n'); // same file, other bytes
  assert.equal(removeIfUnchanged(h.env, fresh), 'changed');
  assert.equal(readFileSync(h.env, 'utf8'), 'A_TOKEN=two\n');
  assert.deepEqual([removeIfUnchanged(h.env, readDotenvFile(h.env)), existsSync(h.env)], ['removed', false]);
  assert.deepEqual(
    readdirSync(h.root).filter(n => n.includes('removing')),
    [],
  );
});

test('review L4: an import retried after an unknown outcome confirms or clears that write in the journal', async t => {
  const h = project(t);
  const journal = new SealedJournal(h.pins.directory, h.pins.lock);
  const lossy = sent =>
    new SealedClient(
      h.project,
      h.account,
      h.keys,
      h.pins,
      {
        ...h.transport,
        write: async input => {
          if (sent) await h.transport.write(input);
          throw new Error('synthetic lost reply');
        },
      },
      false,
    );
  for (const [sent, settledAs] of [
    [true, 'unchanged'],
    [false, 'imported'],
  ]) {
    writeFileSync(h.env, `A_TOKEN=a-${sent}\nB_TOKEN=b-${sent}\n`);
    const unknown = await run(h, lossy(sent)).catch(error => error);
    assert.equal(unknown.code, 'SECRETS_WRITE_UNKNOWN');
    const [open] = await journal.unknown(h.project);
    assert(unknown.message.includes(`nforge secret resolve --operation-id ${open.id}`), unknown.message);
    assert(existsSync(h.env), 'the file stays after an unknown outcome');
    const lines = await run(h);
    assert.match(
      lines.join('\n'),
      settledAs === 'unchanged'
        ? /Already in Development, unchanged: A_TOKEN, B_TOKEN/
        : /Imported into Development: A_TOKEN, B_TOKEN/,
    );
    assert(lines.includes('Settled 1 earlier import write whose outcome was unknown.'), lines.join('\n'));
    assert.deepEqual(await journal.unknown(h.project), []);
    assert(!existsSync(h.env));
  }
});

test('review L5: an agent import over the proposal limit fails before any proposal or write, naming the limit', async t => {
  const h = project(t);
  const existing = Array.from({ length: 9 }, (_, i) => `HELD_${i}`);
  for (const name of existing) await h.client.write(name, Buffer.from(`person-${name}`));
  const before = h.writes();
  const fresh = Array.from({ length: 86 }, (_, i) => `NEW_${String(i).padStart(2, '0')}`);
  // One write's worth, then several writes with the existing names split across them.
  for (const names of [
    [...existing, 'NEW_ONE'],
    [...existing.slice(0, 5), ...fresh, ...existing.slice(5)],
  ]) {
    writeFileSync(h.env, names.map(n => `${n}=agent-${n}`).join('\n'));
    const refused = await run(h, h.agent).catch(error => error);
    assert.equal(refused.code, 'SECRETS_NOT_ALLOWED');
    assert.match(
      refused.message,
      /at most 8 proposals wait per device and 32 per set .*Nothing was proposed or written/,
    );
    assert.equal(h.writes(), before);
    assert.equal(h.s.tables.sealedSecretProposals.size, 0);
    assert(existsSync(h.env));
  }
});

test('a first Development write takes at most 98 names, the server work cap less the first roster entry', async t => {
  const h = project(t);
  const changes = Array.from({ length: 99 }, (_, i) => ({ name: `FIRST_${i}`, value: Buffer.from('x') }));
  await assert.rejects(h.client.writeMany(changes), code('BAD_ARGUMENT'));
  assert.equal(h.writes(), 0);
  await h.client.writeMany(changes.slice(0, 98));
  assert.equal(Object.keys(await values(h.client)).length, 98);
});
