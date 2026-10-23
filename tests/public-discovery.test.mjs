// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { job, state } from './hosted-fixture.mjs';
const hosted = await import(moduleUrl('../convex/hosted.ts'));
const imports = await import(moduleUrl('../convex/imports.ts'));

test('public discovery uses current anonymous provider access, retains original pins and never reads source or private choices', async () => {
  const publicJob = id => ({
    ...job(id),
    visibility: 'public',
    scope: 'public',
    repository: `example/${id}`,
    owner: 'private-owner-label',
  });
  const s = state([
    job('private'),
    publicJob('public'),
    { ...publicJob('changed-private') },
    { ...publicJob('trash'), removal: 'trash' },
    { ...publicJob('unfinished'), phase: 'indexing' },
    { ...publicJob('missing'), artifactKey: undefined },
  ]);
  const previous = globalThis.fetch,
    calls = [],
    before = JSON.stringify([...s.tables.imports.values()]);
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    calls.push(url.pathname);
    assert.equal(url.hostname, 'api.github.com', 'No personal Clerk credential read.');
    const name = url.pathname.split('/').at(-1);
    return Response.json({
      full_name: `example/${name}`,
      private: name === 'changed-private',
      default_branch: 'main',
      html_url: `https://github.com/example/${name}`,
      license: {
        key: 'mit',
        name: 'MIT License',
        spdx_id: 'MIT',
        url: 'https://api.github.com/licenses/mit',
      },
    });
  };
  try {
    for (const caller of [undefined, 'owner', 'other']) {
      s.caller(caller);
      const page = JSON.parse(
        await hosted.discover._handler(s.ctx, { paginationOpts: { cursor: null, numItems: 20 } }),
      );
      assert.deepEqual(
        page.page.map(item => item.id),
        ['public'],
      );
      assert.equal(page.unavailable, 1);
      assert.equal(page.isDone, true);
      assert.equal(page.page[0].head, 'a'.repeat(40));
      assert.equal(page.page[0].license.spdx_id, 'MIT');
      assert.equal(page.page[0].ref, 'main');
      assert(!JSON.stringify(page).includes('private-owner-label'));
      assert(!JSON.stringify(page).includes('artifactKey'));
      assert(!JSON.stringify(page).includes('changed-private'));
    }
    assert.equal(s.reads(), 0);
    assert.equal(s.scheduled.length, 0);
    assert.deepEqual(s.deleted, []);
    assert.equal(JSON.stringify([...s.tables.imports.values()]), before);
    assert(!calls.some(url => url.endsWith('/private') || url.includes('applications')));
    globalThis.fetch = async () => Response.json({ message: 'Unavailable' }, { status: 503 });
    const outage = JSON.parse(
      await hosted.discover._handler(s.ctx, { paginationOpts: { cursor: null, numItems: 20 } }),
    );
    assert.deepEqual(outage.page, []);
    assert.equal(outage.unavailable, 2);
    globalThis.fetch = async () => {
      throw new Error('Network lost');
    };
    await assert.rejects(
      hosted.discover._handler(s.ctx, { paginationOpts: { cursor: null, numItems: 20 } }),
      e => e.data.code === 'HOSTED_REQUEST_FAILED',
    );
  } finally {
    globalThis.fetch = previous;
  }
});

test('discovery pages remain explicit and concurrent source/lifecycle/visibility changes cannot publish stale metadata', async () => {
  const row = { ...job('public'), scope: 'public', visibility: 'public' },
    s = state([row, { ...row, _id: 'second' }]);
  const first = await imports.publicPage._handler(s.ctx, { paginationOpts: { cursor: null, numItems: 1 } });
  assert.equal(first.page.length, 1);
  assert.equal(first.isDone, false);
  const next = await imports.publicPage._handler(s.ctx, {
    paginationOpts: { cursor: first.continueCursor, numItems: 1 },
  });
  assert.equal(next.page.length, 1);
  assert.notEqual(next.page[0], first.page[0]);
  assert.equal(next.isDone, true);
  const fetch = globalThis.fetch,
    query = s.ctx.runQuery;
  let mutation = () => {};
  globalThis.fetch = async () => {
    mutation();
    return Response.json({
      full_name: 'example/project',
      private: false,
      default_branch: 'main',
      html_url: 'https://github.com/example/project',
      license: null,
    });
  };
  try {
    for (const patch of [
      { head: 'b'.repeat(40) },
      { generation: 2 },
      { artifactKey: 'changed' },
      { repository: 'changed/project' },
      { ref: 'changed' },
      { visibility: 'private' },
      { removal: 'trash' },
      { phase: 'indexing' },
      { head: undefined },
      { artifactKey: undefined },
    ]) {
      s.tables.imports.set('public', { ...row });
      s.tables.imports.delete('second');
      mutation = () => Object.assign(s.tables.imports.get('public'), patch);
      const page = JSON.parse(
        await hosted.discover._handler(s.ctx, { paginationOpts: { cursor: null, numItems: 20 } }),
      );
      assert.deepEqual(page.page, []);
      assert.equal(page.unavailable, 1);
    }
    s.tables.imports.set('public', { ...row });
    mutation = () => {};
    s.ctx.runQuery = async (fn, args) => {
      const result = await query(fn, args);
      if (getFunctionName(fn) === 'imports:publicPage') s.tables.imports.get('public').visibility = 'private';
      return result;
    };
    const page = JSON.parse(
      await hosted.discover._handler(s.ctx, { paginationOpts: { cursor: null, numItems: 20 } }),
    );
    assert.deepEqual(page.page, []);
    assert.equal(page.unavailable, 1);
    assert.equal(s.reads(), 0);
    assert.equal(s.scheduled.length, 0);
  } finally {
    globalThis.fetch = fetch;
  }
});
