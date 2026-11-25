// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { historicalArchiveActions } from './historical-archive-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
const projectBackups = await import(moduleUrl('../convex/projectBackups.ts'));
const actions = historicalArchiveActions(await import(moduleUrl('../convex/projectBackupActions.ts')));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const page = { paginationOpts: { cursor: null, numItems: 20 } };
function fixture() {
  const s = state([]),
    native = s.ctx.runQuery;
  let urls = 0;
  s.tables.hostedProjects = new Map();
  s.tables.projectBackups = new Map();
  s.ctx.runQuery = s.ctx.runMutation = (ref, args) =>
    getFunctionName(ref).startsWith('projectBackups:')
      ? projectBackups[getFunctionName(ref).split(':')[1]]._handler(s.ctx, args)
      : native(ref, args);
  s.ctx.storage.generateUploadUrl = async () => `https://fixture.invalid/${++urls}`;
  s.ctx.db.system.query = () => ({
    order: () => ({
      paginate: async ({ cursor, numItems }) => {
        const rows = [...s.files].map(([id, file]) => ({ _id: id, ...file.metadata })),
          start = Number(cursor ?? 0);
        return {
          page: rows.slice(start, start + numItems),
          isDone: start + numItems >= rows.length,
          continueCursor: String(start + numItems),
        };
      },
    }),
  });
  s.put = (id, bytes, type) =>
    s.files.set(id, {
      blob: new Blob([bytes], { type }),
      metadata: {
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('base64'),
        contentType: type,
      },
    });
  s.urls = () => urls;
  return s;
}
const input = bytes => ({
  key: randomUUID(),
  name: 'Forge',
  operationId: randomUUID(),
  previous: null,
  digest: sha(bytes),
  size: bytes.length,
  preview: {
    manifestDigest: 'a'.repeat(64),
    head: 'b'.repeat(40),
    format: 'sha1',
    revision: 7,
    intents: 2,
    lanes: 4,
    views: 3,
    runs: 3,
    files: 15,
    unavailable: 0,
    channels: [{ name: 'main', head: 'c'.repeat(40) }],
  },
});
