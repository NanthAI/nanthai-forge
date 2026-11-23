// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// `history log` with a path on a project made on Forge (no imported Git history, Item 3968a655) reads the web's
// file history window: the real history action refuses, then one projectCode:fileHistory query per page.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { moduleUrl } from './convex-module.mjs';
import { landingFixture, path } from './code-file-history-fixture.mjs';
import { getFunctionName } from 'convex/server';
import { hostedHistory } from '../dist/hosted-history-cli.js';
import { hostedHistoryCli } from '../dist/hosted-history-output.js';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';
import { landedBy } from '../dist/code-history.js';

const modules = {
  projectCode: await import(moduleUrl('../convex/projectCode.ts')),
  projectHistoryRead: await import(moduleUrl('../convex/projectHistoryRead.ts')),
};
const address = { url: 'https://example.convex.cloud', projectId: 'project' };

/** The CLI transport's shape, routed to the real handlers; `calls` counts server calls per read. */
function forgeProject(t) {
  // The first page looks for a local Git cache before asking; tests never use the machine's.
  const cache = mkdtempSync(join(tmpdir(), 'forge-history-cache-'));
  const previous = process.env.FORGE_HISTORY_CACHE;
  process.env.FORGE_HISTORY_CACHE = cache;
  t.after(() => {
    if (previous === undefined) delete process.env.FORGE_HISTORY_CACHE;
    else process.env.FORGE_HISTORY_CACHE = previous;
    rmSync(cache, { recursive: true, force: true });
  });
  const f = landingFixture('private');
  const calls = [];
  const call = async (name, args) => {
    calls.push(name);
    const [module, fn] = name.split(':');
    return JSON.parse(await modules[module][fn]._handler(f.ctx, { ...args, projectId: 'project' }));
  };
  const io = { action: call, query: call, mutation: () => assert.fail('a log never writes') };
  const log = async command => {
    calls.length = 0;
    const result = await hostedHistory(address, { op: 'log', ...command }, io, () =>
      assert.fail('a landing log downloads nothing'),
    );
    return { result, calls: [...calls] };
  };
  const web = async before =>
    JSON.parse(await modules.projectCode.fileHistory._handler(f.ctx, { projectId: 'project', path, before }));
  return { ...f, cache, log, web };
}

test('a Forge-made project answers a file log with the web landing window and pages by its cursor', async t => {
  const f = forgeProject(t);
  for (let i = 1; i <= 30; i++) f.add(i, i % 3 === 0 ? [path] : ['other.ts']);
  const first = await f.log({ path, limit: 50 });
  assert.deepEqual(first.calls, ['projectHistoryRead:open', 'projectCode:fileHistory']);
  const web = await f.web(null);
  assert.equal(first.result.readMode, 'landings');
  assert.deepEqual(
    first.result.entries,
    web.landings.map(row => ({
      at: row.at,
      title: row.title,
      by: landedBy(row),
      receiptId: row.receiptId,
      state: row.head,
    })),
  );
  assert.deepEqual(
    first.result.entries.map(entry => entry.title),
    [30, 27, 24, 21, 18, 15, 12, 9].map(n => `Landing ${n}`),
  );
  assert.ok(first.result.entries.every(entry => typeof entry.by === 'string'));
  assert.equal(first.result.matched, 8);
  assert.equal(first.result.examined, web.scanned);
  assert.match(first.result.nextCursor, new RegExp(`^${web.nextBefore}\\.[0-9a-f]{8}$`));
  // The cursor is bound to this project and path: it never continues another file's log.
  await assert.rejects(
    f.log({ path: 'other.ts', cursor: first.result.nextCursor }),
    error => error.code === 'BAD_ARGUMENT',
  );
  // The continuation is the one query alone, from exactly where the web's next step starts.
  const second = await f.log({ path, cursor: first.result.nextCursor });
  assert.deepEqual(second.calls, ['projectCode:fileHistory']);
  assert.deepEqual(
    second.result.entries.map(entry => entry.title),
    ['Landing 6', 'Landing 3'],
  );
  assert.deepEqual(
    second.result.entries.map(entry => entry.receiptId),
    (await f.web(web.nextBefore)).landings.map(row => row.receiptId),
  );
  assert.equal(second.result.nextCursor, null);
  assert.equal(second.result.more, false);
});

test('a page with no match still continues until the old landing that changed the file', async t => {
  const f = forgeProject(t);
  for (let i = 1; i <= 120; i++) f.add(i, i === 1 ? [path] : ['other.ts']);
  const first = await f.log({ path });
  assert.deepEqual(first.result.entries, []);
  assert.equal(first.result.matched, 0);
  assert.ok(first.result.examined > 0 && first.result.examined < 120);
  assert.ok(first.result.nextCursor);
  let page = first.result,
    examined = page.examined,
    pages = 1;
  while (page.nextCursor && pages < 10) {
    const next = await f.log({ path, cursor: page.nextCursor });
    assert.deepEqual(next.calls, ['projectCode:fileHistory']);
    page = next.result;
    examined += page.examined;
    pages += 1;
  }
  assert.deepEqual(
    page.entries.map(entry => entry.title),
    ['Landing 1'],
  );
  assert.equal(page.nextCursor, null);
  assert.equal(examined, 120, 'every landing is examined exactly once across pages');
});

test('a path no landing changed reads as an empty, finished log with what was examined', async t => {
  const f = forgeProject(t);
  for (let i = 1; i <= 5; i++) f.add(i, ['other.ts']);
  const { result } = await f.log({ path: 'never/changed.ts' });
  assert.deepEqual(
    [result.entries, result.matched, result.examined, result.unknown, result.nextCursor],
    [[], 0, 5, 0, null],
  );
  // The CLI form through the real client transport: its typed refusal turns into the same landing log.
  const call = async (ref, args) => {
    const [module, fn] = getFunctionName(ref).split(':');
    return modules[module][fn]._handler(f.ctx, args);
  };
  const real = new HostedAgentTransport(f.cache, address, {
    projectId: 'project',
    client: { action: call, query: call, mutation: () => assert.fail('a log never writes') },
  });
  const cli = await hostedHistoryCli(f.cache, { op: 'log', path: 'never/changed.ts' }, address, real);
  assert.deepEqual(cli, { action: 'history', result });
});

test('a Forge-made project refuses a log without a path by naming the path form, and commit or skip', async t => {
  const f = forgeProject(t);
  f.add(1, [path]);
  await assert.rejects(
    f.log({}),
    error =>
      error.code === 'HISTORY_UNAVAILABLE' && error.message.includes('history {"op":"log","path":"FILE"}'),
  );
  for (const extra of [{ skip: 8 }, { commit: 'abcd' }])
    await assert.rejects(f.log({ path, ...extra }), error => error.code === 'BAD_ARGUMENT');
});
