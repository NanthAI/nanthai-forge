// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { pullFixture } from './hosted-pull-fixture.mjs';
import { pullHostedProject } from '../dist/hosted-pull.js';
import { cloneLocalEdits } from '../dist/clone-local-edits.js';

const generated = [
  ['convex/_generated/api.js', 'api v1\n'],
  ['convex/_generated/server.js', 'server v1\n'],
];

/** Incident 2026-11 (friction 9367f1b7): a dev Convex push from the clone root rewrote tracked codegen output and nforge pull refused. */
test('a local codegen rewrite under convex/_generated neither blocks pull nor lists as an edit; a main-added path codegen made first is replaced', async t => {
  const f = pullFixture(t, 3, generated);
  fs.writeFileSync(join(f.root, 'convex/_generated/api.js'), 'api regenerated locally\n');
  assert.equal(cloneLocalEdits(f.root).count, 0);
  f.select([['convex/_generated/api.js', 'api v2\n']]);
  await pullHostedProject(f.root, f.address, f.transport);
  assert.equal(fs.readFileSync(join(f.root, 'convex/_generated/api.js'), 'utf8'), 'api v2\n');
});

test('a real source edit still blocks pull while generated output differs', async t => {
  const f = pullFixture(t, 3, generated);
  fs.writeFileSync(join(f.root, 'convex/_generated/api.js'), 'regenerated\n');
  fs.writeFileSync(join(f.root, 'src/0.txt'), 'local');
  await assert.rejects(pullHostedProject(f.root, f.address, f.transport), { code: 'WORK_CONFLICT' });
  assert.deepEqual(
    cloneLocalEdits(f.root).files.map(file => file.path),
    ['src/0.txt'],
  );
});
