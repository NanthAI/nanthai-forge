// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';
import { durabilityFixture, mainHead } from './hosted-durability-fixture.mjs';
import { snapshotEvents } from '../scripts/lib/hosted-durability-compare.mjs';
import {
  compareProjectRows,
  readProjectSnapshot,
  readRestoredRows,
} from '../scripts/lib/restore-drill-project.mjs';

const restoredDocuments =
  'CREATE TABLE documents (id BLOB NOT NULL, ts INTEGER NOT NULL, table_id BLOB NOT NULL, json_value TEXT NULL, deleted INTEGER NOT NULL, prev_ts INTEGER, PRIMARY KEY (ts, table_id, id))';

async function temporary(run) {
  const directory = await mkdtemp(join(tmpdir(), 'forge-restore-completion-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function zip(path, tables) {
  const script = `import json,sys,zipfile
with zipfile.ZipFile(sys.argv[1], 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    for table, rows in json.load(sys.stdin).items():
        archive.writestr(table + '/documents.jsonl', ''.join(json.dumps(row) + '\\n' for row in rows))
    archive.writestr('_storage/blob', 'payload')
`;
  const result = spawnSync('python3', ['-c', script, path], { input: JSON.stringify(tables) });
  assert.equal(result.status, 0);
}

test('a backup taken mid-completion retains the Lane head and unapplied acceptance page on restore', () =>
  temporary(async directory => {
    const projectId = 'k'.repeat(32),
      tables = JSON.parse(JSON.stringify(durabilityFixture()).replaceAll('"project"', `"${projectId}"`));
    const applied = { _id: 'applied-lane', projectId, kind: 'lane', status: 'completed', version: 1 };
    const pending = { _id: 'pending-lane', projectId, kind: 'lane', status: 'active', version: 0 };
    const plan = {
      _id: 'partly-applied',
      projectId,
      receiptId: 'accepted',
      inputPages: 1,
      appliedPage: 0,
      appliedEntry: 1,
      completion: { tick: 'original-scheduler-id', guard: null },
    };
    const page = {
      _id: 'completion-page',
      projectId,
      receiptId: plan.receiptId,
      kind: 'inputs',
      index: 0,
      value: JSON.stringify([
        { laneId: applied._id, version: 0 },
        { laneId: pending._id, version: 0 },
      ]),
    };
    tables.projectHostedRecordHeads = [applied, pending];
    tables.projectHostedAcceptanceSnapshots = [
      { _id: 'selected-delta', projectId, receiptId: plan.receiptId, snapshotId: 'snapshot', head: mainHead },
    ];
    tables.projectHostedAcceptancePlans = [plan];
    tables.projectHostedAcceptancePages = [page];
    const backup = join(directory, 'backup.zip'),
      restored = join(directory, 'restored.zip');
    zip(backup, tables);
    const source = await readProjectSnapshot(backup, projectId, {
      sink: file => pipeline(file, createWriteStream(restored, { flags: 'wx' })),
    });
    const database = join(directory, 'database.sqlite3');
    const db = new DatabaseSync(database);
    const rows = [];
    try {
      db.exec(restoredDocuments);
      const tablet = number => Buffer.alloc(16, number);
      const insert = db.prepare('INSERT INTO documents VALUES (?, ?, ?, ?, 0, NULL)');
      insert.run(tablet(1), 1, tablet(1), JSON.stringify({ name: '_tables', state: 'active' }));
      const ids = new Map();
      let sequence = 1;
      // Model the pinned Convex backend's imported rows and read them using the same
      // database reader as the real restore drill.
      for await (const event of snapshotEvents(restored)) {
        if (event.kind === 'table' && !event.table.startsWith('_')) {
          const id = tablet(ids.size + 2);
          ids.set(event.table, id);
          insert.run(id, ++sequence, tablet(1), JSON.stringify({ name: event.table, state: 'active' }));
        } else if (event.kind === 'record' && ids.has(event.table)) {
          insert.run(tablet(++sequence), sequence, ids.get(event.table), JSON.stringify(event.value));
          if (event.table.startsWith('projectHosted')) rows.push(event.value);
        }
      }
    } finally {
      db.close();
    }
    assert.deepEqual(rows, [applied, pending, tables.projectHostedAcceptanceSnapshots[0], plan, page]);
    const imported = readRestoredRows(database, projectId);
    assert.equal(compareProjectRows(source.rows, imported.rows).equal, true);

    // Simulate losing the pending page. A snapshot containing only the visible
    // Lane states must fail the row comparison.
    imported.rows.delete('projectHostedAcceptancePages\tcompletion-page');
    const mismatch = compareProjectRows(source.rows, imported.rows);
    assert.deepEqual(mismatch.differing, [
      { row: 'projectHostedAcceptancePages/completion-page', reason: 'missing' },
    ]);
  }));
