// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Landings on main with their Candidates' retained changed paths: the records a file's landing history reads
// (convex/projectCodeFileHistory.ts). Shared by the web read's tests and the CLI landing log's.
import { digest } from '../dist/hash.js';
import { state } from './hosted-fixture.mjs';

export const path = 'src/entry.ts';
export const before = 'a'.repeat(64);
const after = 'b'.repeat(64);

export function landingFixture(visibility = 'public') {
  const f = state([]);
  const query = f.ctx.db.query;
  f.ctx.db.query = table => {
    const builder = query(table);
    if (table === 'projectHostedAcceptances') {
      // The shared fixture caps rows. Model the provider's separate pagination byte boundary here.
      const paginate = builder.paginate;
      builder.paginate = async opts => {
        const result = await paginate(opts);
        let bytes = 0;
        const page = [];
        for (const row of result.page) {
          bytes += Buffer.byteLength(JSON.stringify(row));
          if (page.length && bytes > (opts.maximumBytesRead ?? Infinity)) break;
          page.push(row);
        }
        return { ...result, page, isDone: result.isDone && page.length === result.page.length };
      };
    }
    return builder;
  };
  const put = (table, id, fields) =>
    f.tables[table].set(id, { _id: id, _creationTime: 1, projectId: 'project', ...fields });
  put('hostedProjects', 'project', { owner: 'owner', name: 'Example', slug: 'example', visibility });
  put('forgeAccounts', 'account', { owner: 'owner', handle: 'ada' });
  put('accountHandles', 'handle', { owner: 'owner', handle: 'ada' });
  put('projectSlugs', 'slug', { owner: 'owner', slug: 'example' });
  function add(
    sequence,
    paths,
    {
      candidateId = `candidate-${sequence}`,
      head = after,
      recordHead = head,
      actor = 'owner',
      wrongDigest = false,
      docsResolution,
    } = {},
  ) {
    const receiptId = `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
    const value = JSON.stringify({
      kind: 'candidate',
      id: candidateId,
      base: { head: before },
      result: { status: 'clean', head: recordHead },
      governance: { paths },
    });
    const pinned =
      paths === undefined
        ? f.tables.projectHostedRecords.get(`record-${candidateId}`)?.digest
        : digest(value);
    if (actor !== 'owner') put('forgeAccounts', `account-${actor}`, { owner: actor, handle: actor });
    put('projectHostedAcceptances', receiptId, {
      _creationTime: sequence,
      sequence,
      receiptId,
      value: JSON.stringify({
        id: receiptId,
        at: '2026-11-01T00:00:00.000Z',
        actor: { id: actor, kind: 'person' },
        message: `Landing ${sequence}`,
        previous: { head: before },
        candidate: { id: candidateId, head, digest: wrongDigest ? '0'.repeat(64) : pinned },
        automatic: false,
        docsResolution,
      }),
    });
    if (paths === undefined) return;
    const bodyId = `body-${candidateId}`;
    put('projectHostedRecordBodies', bodyId, { value });
    put('projectHostedRecords', `record-${candidateId}`, {
      kind: 'candidate',
      key: candidateId,
      version: 0,
      bodyId,
      digest: digest(value),
      bytes: Buffer.byteLength(value),
    });
  }
  return { ...f, add };
}
