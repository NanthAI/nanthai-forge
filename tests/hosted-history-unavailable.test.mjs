// SPDX-License-Identifier: Apache-2.0
// Friction bae7e553: `history` on a project without stored history printed INTERNAL_ERROR; the server's
// HISTORY_UNAVAILABLE code and message must reach the caller. Kept apart from the busy history file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
import { hostedHistoryCli } from '../dist/hosted-history-output.js';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';

const modules = {};
for (const name of ['projectHistoryStore', 'projectHistoryRead'])
  modules[name] = await import(moduleUrl(`../convex/${name}.ts`));
const address = projectId => ({ url: 'https://example.convex.cloud', projectId });

test('history on a project without stored history prints HISTORY_UNAVAILABLE with its message, not INTERNAL_ERROR', async t => {
  const s = state([]);
  const original = s.ctx.runQuery;
  s.ctx.runQuery = async (ref, args) => {
    const [name, fn] = getFunctionName(ref).split(':');
    return modules[name] ? modules[name][fn]._handler(s.ctx, args) : original(ref, args);
  };
  const projectId = await s.ctx.db.insert('hostedProjects', {
    key: 'none',
    name: 'None',
    currentBackup: null,
    revision: 0,
    owner: 'owner',
    visibility: 'private',
    sourceAuthority: { mode: 'server', epoch: 1 },
  });
  const dir = mkdtempSync(join(tmpdir(), 'forge-history-status-'));
  const saved = process.env.FORGE_HISTORY_CACHE;
  process.env.FORGE_HISTORY_CACHE = join(dir, 'history-cache');
  t.after(() => {
    if (saved === undefined) delete process.env.FORGE_HISTORY_CACHE;
    else process.env.FORGE_HISTORY_CACHE = saved;
    rmSync(dir, { recursive: true, force: true });
  });
  // The real server handler throws its ConvexError through the real client transport.
  const call = async (ref, args) => {
    const [module, fn] = getFunctionName(ref).split(':');
    return modules[module][fn]._handler(s.ctx, { ...args, projectId });
  };
  const real = new HostedAgentTransport(dir, address(projectId), {
    projectId,
    client: { action: call, mutation: call, query: call },
  });
  const wanted = e => e.code === 'HISTORY_UNAVAILABLE' && /no imported Git history/.test(e.message);
  await assert.rejects(real.action('projectHistoryRead:open', { cached: [] }), wanted);
  await assert.rejects(hostedHistoryCli(dir, { op: 'status' }, address(projectId), real), wanted);
  // A transport that still throws the raw server error is converted by the CLI form too.
  const raw = {
    action: (name, args) => run(name, args),
    mutation: (name, args) => run(name, args),
  };
  const run = async (name, args) => {
    const [module, fn] = name.split(':');
    return JSON.parse(await modules[module][fn]._handler(s.ctx, { ...args, projectId }));
  };
  await assert.rejects(hostedHistoryCli(dir, { op: 'status' }, address(projectId), raw), wanted);
  await assert.rejects(hostedHistoryCli(dir, { op: 'retry' }, address(projectId), raw), wanted);
});
