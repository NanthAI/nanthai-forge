// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture } from './hosted-sync-client-fixture.mjs';
import { applyHostedSync } from '../dist/hosted-sync-client.js';
import { recoverLocalApply } from '../dist/hosted-apply-recovery.js';
import { gcNestedLanes } from '../dist/client-cache-gc.js';
import { clientCacheRoot } from '../dist/root-paths.js';
import { digest } from '../dist/hash.js';

for (const phase of ['after-receipt', 'after-move', 'interrupted-after-move', 'after-verification'])
  test(`concurrent user content in a legacy candidate survives apply and real nested GC (${phase})`, async t => {
    const s = await fixture(t);
    const owner = s.root + '-owner',
      parentCache = clientCacheRoot(owner);
    const root = join(parentCache, 'lanes', randomUUID());
    fs.mkdirSync(join(parentCache, 'lanes'), { recursive: true });
    fs.renameSync(s.root, root);
    fs.renameSync(clientCacheRoot(s.root), clientCacheRoot(root));
    const candidate = join(root, '..forge-client'),
      bytes = Buffer.from('verified cached bytes'),
      id = digest(bytes);
    fs.mkdirSync(join(candidate, 'objects'), { recursive: true });
    fs.writeFileSync(join(candidate, 'objects', id), bytes);
    const request = s.command(),
      rename = fs.renameSync;
    let injected = false,
      moved,
      note;
    t.mock.method(fs, 'renameSync', (from, to) => {
      const result = rename(from, to);
      const publication = String(to).endsWith('..forge-client.json');
      const receipt = publication ? JSON.parse(fs.readFileSync(to)) : null;
      const hit =
        phase === 'after-receipt'
          ? receipt?.from === candidate && !moved
          : phase === 'after-verification'
            ? receipt?.status === 'verified'
            : from === candidate;
      if (from === candidate) moved = to;
      if (!injected && hit) {
        injected = true;
        note = join(
          phase === 'after-receipt' ? candidate : (moved ?? receipt.preservedAt),
          'private-notes.txt',
        );
        fs.writeFileSync(note, 'IRREPLACEABLE USER DRAFT');
        if (phase === 'interrupted-after-move') throw Error('Synthetic crash after quarantine move');
      }
      return result;
    });
    syncBuiltinESMExports();
    let blocked, applied;
    try {
      try {
        applied = await applyHostedSync(root, request, s.transport);
      } catch (error) {
        blocked = error;
        if (phase === 'interrupted-after-move') assert.match(error.message, /Synthetic crash/);
        else assert.equal(error.code, 'WORK_CONFLICT');
      }
    } finally {
      fs.renameSync.mock.restore();
      syncBuiltinESMExports();
    }
    assert(injected);
    if (phase === 'interrupted-after-move') {
      await assert.rejects(applyHostedSync(root, request, s.transport), error => {
        blocked = error;
        return error.code === 'WORK_CONFLICT' && error.recovery?.sourceCompleted === true;
      });
    }
    let preservedNote = note;
    if (blocked) {
      assert.equal(
        fs.readFileSync(join(candidate, 'private-notes.txt'), 'utf8'),
        'IRREPLACEABLE USER DRAFT',
        'unexpected content restored as a real obstruction',
      );
      const recovered = await recoverLocalApply(root, blocked.recovery.applyOperationId, s.transport);
      assert.equal(recovered.status, 'applied');
      preservedNote = join(recovered.preservedAt, '..forge-client', 'private-notes.txt');
    } else if (phase !== 'after-verification') {
      // The old implementation succeeds and moves user bytes into disposable
      // cache. Run real GC before asserting survival to catch that exact loss.
      preservedNote = join(applied.localRecovery[0].preservedAt, 'private-notes.txt');
    }
    const gc = gcNestedLanes({
      root: owner,
      settings: { clientCacheMaxGB: 1, clientCacheMaxAgeHours: 1 },
      now: Date.now() + 48 * 3600000,
    });
    assert.equal(gc.evicted.length, 1, 'actual clean nested checkout and adjacent cache are evicted');
    assert.equal(fs.readFileSync(preservedNote, 'utf8'), 'IRREPLACEABLE USER DRAFT');
    assert(!preservedNote.startsWith(parentCache + '/'), 'user bytes never live in disposable caches');
  });
