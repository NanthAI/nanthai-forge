// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item 7456856f: the bulk delete request page as data. The count the owner types follows the projects kept out,
// progress reads per project, and an expired, declined or skipped request says that nothing was deleted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';

const { requestView, rowState, bytesText } = await import(moduleUrl('../web/src/app/requests/model.ts'));
const { deleteRequestHref, parseAppPath } = await import(moduleUrl('../web/src/app/paths.ts'));
const { safeNext } = await import(moduleUrl('../web/src/app/session.ts'));

const project = (i, extra = {}) => ({
  projectId: `p${i}`,
  slug: `bench-zoo-${i}`,
  bytes: 1024 ** 2 * (i + 1),
  trash: i % 2 === 1,
  lastLandingAt: null,
  outcome: null,
  ...extra,
});
const read = (projects, extra = {}) => ({
  id: 'request',
  status: 'requested',
  selector: 'bench-zoo-*',
  byDevice: true,
  at: '2026-11-17T08:00:00.000Z',
  expiresAt: '2026-11-17T08:30:00.000Z',
  projects,
  ...extra,
});

test('keeping a project out lowers the count to type, the bytes and the not-in-trash warning', () => {
  const list = read([0, 1, 2, 3].map(i => project(i)));
  const all = requestView(list, new Set(), '');
  assert.equal(all.count, 4);
  assert.equal(all.notInTrash, 2);
  assert.equal(all.confirmed, false);
  assert.match(all.sentence.bold, /^4 projects to delete for good\.$/);
  const kept = requestView(list, new Set(['p0']), '3');
  assert.equal(kept.count, 3);
  assert.equal(kept.notInTrash, 1);
  assert.equal(kept.confirmed, true);
  assert.equal(bytesText(kept.bytes), '9 MB');
  assert.equal(requestView(list, new Set(['p0']), '4').confirmed, false, 'the old count no longer confirms');
  assert.deepEqual(rowState(list.projects[0], new Set(['p0'])), { word: 'Kept', tone: 'stale' });
});

test('progress, failures and skips read per project after approval', () => {
  const running = requestView(
    read(
      [
        project(0, { outcome: 'deleted' }),
        project(1, { outcome: 'started' }),
        project(2, { outcome: 'kept' }),
      ],
      {
        status: 'approved',
      },
    ),
    new Set(),
    '',
  );
  assert.equal(running.sentence.bold, 'Deleting 1 of 2.');
  const failed = requestView(
    read([project(0, { outcome: 'deleted' }), project(1, { outcome: 'failed' })], { status: 'approved' }),
    new Set(),
    '',
  );
  assert.equal(failed.failed, 1);
  assert.match(failed.sentence.rest, /Retry resumes only the purges that stopped/);
  const skipped = requestView(
    read([project(0, { outcome: 'deleted' }), project(1, { outcome: 'changed' })], { status: 'approved' }),
    new Set(),
    '',
  );
  assert.equal(skipped.sentence.bold, '1 project deleted for good.');
  assert.match(skipped.sentence.rest, /1 project skipped, named below/);
  assert.equal(rowState(project(1, { outcome: 'changed' }), new Set()).word, 'Skipped, it changed');
});

test('sign-in keeps the same account request through its redirect', () => {
  const href = deleteRequestHref('request + exact');
  const fromSignIn = safeNext(href);
  assert.equal(fromSignIn, href);
  const url = new URL(fromSignIn, 'https://forge.example');
  assert.deepEqual(parseAppPath(url.pathname), { frame: 'account', place: 'projects' });
  assert.equal(url.searchParams.get('request'), 'request + exact');
});

test('an expired or declined request says nothing was deleted and cannot be confirmed', () => {
  for (const status of ['expired', 'declined', 'withdrawn']) {
    const view = requestView(read([project(0)], { status }), new Set(), '1');
    assert.equal(view.open, false);
    assert.equal(view.confirmed, false);
    assert.match(`${view.sentence.bold} ${view.sentence.rest}`, /Nothing was deleted/);
  }
});
