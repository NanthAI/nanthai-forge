// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeDependencyHead, nativeDependencyLookup } from '../dist/native-pr-pins.js';
import { archiveSource, archiveChannels, workSourcePins } from '../dist/work-archive-metadata.js';
import { overlayHostedJournal } from '../dist/work-backup.js';
import { applyHostedEvent, metadataRequest, workBytes } from '../dist/work-metadata.js';
import { workSchema } from '../dist/work-types.js';
import { digest } from '../dist/hash.js';

const head = 'a'.repeat(64),
  other = 'b'.repeat(64);
const intent = () => ({
  id: randomUUID(),
  outcome: 'Source membership',
  constraints: '',
  base: head,
  status: 'active',
  notes: [],
  createdAt: 'time',
});
const empty = () =>
  workSchema.parse({ schema: 8, revision: 0, nativeHead: head, intents: [intent()], lanes: [], views: [] });
const view = (id, pin, dependencies = []) => ({
  id,
  intentId: pin.id,
  base: head,
  head,
  inputs: [],
  status: 'clean',
  details: '',
  at: 'time',
  dependencies,
});

test('indexed dependency validation preserves first Intent and any matching clean View semantics', () => {
  const data = empty(),
    id = randomUUID(),
    git = 'c'.repeat(40);
  data.views = [
    { ...view(id, data.intents[0]), status: 'conflict' },
    view(id, data.intents[0]),
    { ...view(id, data.intents[0]), head: other },
  ];
  data.intents[0].external = { observations: [{ head: git, native: { head, base: other } }] };
  data.intents.push({
    ...data.intents[0],
    external: { observations: [{ head: git, native: { head: other } }] },
  });
  const pins = [
    { kind: 'view', viewId: id, head },
    { kind: 'view', viewId: id, head: other },
    { kind: 'pr', intentId: data.intents[0].id, observation: 0, head: git },
  ];
  const lookup = nativeDependencyLookup(data);
  for (const pin of pins)
    assert.equal(nativeDependencyHead(data, pin, lookup), nativeDependencyHead(data, pin));
  for (const pin of [
    { ...pins[0], head: 'd'.repeat(64) },
    { ...pins[2], observation: 1 },
  ]) {
    let original;
    try {
      nativeDependencyHead(data, pin);
    } catch (error) {
      original = error;
    }
    assert.throws(
      () => nativeDependencyHead(data, pin, lookup),
      error => error.code === original.code && error.message === original.message,
    );
  }
});

test('manifest membership preserves pin order, exact path/hash pairs and latest accepted Channel ordering', () => {
  const data = empty();
  data.intents.push({ ...intent(), base: other });
  data.channelMoves = [
    { channel: 'main', head, status: 'accepted' },
    { channel: 'other', head, status: 'accepted' },
    { channel: 'main', head: other, status: 'accepted' },
    { channel: 'other', head: other, status: 'rejected' },
  ];
  const manifest = {
    kind: 'forge-native-work-backup',
    head,
    files: [
      { path: `objects/${head}`, sha256: other },
      { path: `objects/${head}`, sha256: head },
      { path: `objects/${other}`, sha256: other },
    ],
  };
  const original = workSourcePins(data).filter(pin =>
    manifest.files.some(file => file.path === `objects/${pin}` && file.sha256 === pin),
  );
  assert.deepEqual(archiveSource(manifest, data), { head, states: original });
  assert.deepEqual(archiveChannels(manifest, data), [
    { name: 'main', head: other },
    { name: 'other', head },
  ]);
  manifest.files = manifest.files.slice(0, 1);
  assert.deepEqual(archiveSource(manifest, data).states, []);
  const legacy = { kind: 'forge-source-and-work', head, refs: [{ ref: 'refs/forge/channels/main', head }] };
  assert.equal(archiveSource(legacy, data), legacy);
  assert.deepEqual(archiveChannels(legacy, data), [{ name: 'main', head }]);
});

function journalFixture(t, change = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-index-journal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const data = empty();
  change(data);
  const bytes = workBytes(data),
    archive = 'e'.repeat(64),
    projectKey = randomUUID();
  const manifest = {
    schema: 1,
    kind: 'forge-native-work-backup',
    id: randomUUID(),
    head,
    revision: 0,
    files: [
      { path: 'work.json', size: Buffer.byteLength(bytes), sha256: digest(bytes) },
      { path: `objects/${head}`, size: 1, sha256: head },
    ],
    unavailable: [],
    coverage: 'fixture',
  };
  const manifestBytes = JSON.stringify(manifest);
  writeFileSync(join(dir, 'manifest.json'), manifestBytes);
  writeFileSync(join(dir, 'work.json'), bytes);
  const journal = {
    schema: 1,
    kind: 'forge-hosted-work-journal',
    projectKey,
    name: 'fixture',
    base: { archiveSha256: archive, manifestSha256: digest(manifestBytes), workSha256: digest(bytes) },
    events: [],
    revision: 0,
    workSha256: '',
    coverage: 'fixture',
  };
  function append(command) {
    const event = {
      id: randomUUID(),
      projectKey,
      archiveSha256: archive,
      actor: 'owner',
      at: 'time',
      previousRevision: data.revision,
      command,
      request: metadataRequest(command),
    };
    applyHostedEvent(data, event);
    journal.events.push(event);
  }
  function save() {
    journal.revision = data.revision;
    journal.workSha256 = digest(workBytes(data));
    const path = join(dir, 'journal.json');
    writeFileSync(path, JSON.stringify(journal));
    return path;
  }
  return { dir, data, archive, journal, append, save, bytes, manifestBytes };
}
test('journal shares retained source across notes and newly created Intents without changing exact replay bytes', t => {
  const f = journalFixture(t);
  f.append({ action: 'intent', outcome: 'Existing retained base', constraints: '', base: head });
  const id = f.data.intents.at(-1).id;
  for (let i = 0; i < 120; i++)
    f.append({ action: 'note', intentId: id, kind: 'comment', text: `Note ${i}` });
  overlayHostedJournal(f.dir, f.archive, f.save());
  assert.equal(readFileSync(join(f.dir, 'work.json'), 'utf8'), workBytes(f.data));
});
test('note replay still rejects malformed retained dependencies and leaves original files unchanged', t => {
  const f = journalFixture(t, data => {
    data.views.push(view(randomUUID(), data.intents[0], [{ kind: 'view', viewId: randomUUID(), head }]));
  });
  f.append({
    action: 'note',
    intentId: f.data.intents[0].id,
    kind: 'comment',
    text: 'Must not bypass source validation',
  });
  assert.throws(
    () => overlayHostedJournal(f.dir, f.archive, f.save()),
    error => error.code === 'BAD_ARGUMENT',
  );
  assert.equal(readFileSync(join(f.dir, 'work.json'), 'utf8'), f.bytes);
  assert.equal(readFileSync(join(f.dir, 'manifest.json'), 'utf8'), f.manifestBytes);
});
