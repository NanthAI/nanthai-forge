// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item 9d3c407d (owner decision Q83, journey J29-1): the landing secret scan also runs at save, after
// capture and before any upload, so a credential never reaches stored bytes. Synthetic credentials are
// generated per run, never committed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { secretFingerprint } from '../dist/secret-scan.js';
import { clientCacheRoot } from '../dist/root-paths.js';
import { registerHostedAgentWorkflow } from '../dist/mcp-hosted-agent.js';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';
import { resolutionFixture } from './hosted-agent-resolution-fixture.mjs';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const githubToken = () =>
  `ghp_${[...randomBytes(36)].map(byte => alphabet[byte % alphabet.length]).join('')}`;
const uploads = calls =>
  calls.filter(call =>
    /projectHostedSaves:(prepare|submit)|projectObjects:prepare|SaveJobs:submit/.test(call.name),
  );

function refused(error, value, path) {
  assert.equal(error.code, 'SECRET_FOUND');
  assert.match(error.message, new RegExp(`${path.replace('.', '\\.')}:2 github-token`));
  assert.match(error.message, /Nothing was stored/);
  assert.equal(error.recovery.next.action, 'save');
  assert.match(error.recovery.command, / save /);
  assert.deepEqual(
    error.recovery.findings.map(({ path, line, kind }) => ({ path, line, kind })),
    [{ path, line: 2, kind: 'github-token' }],
  );
  assert.equal(error.recovery.allowEntries[0].reason, '');
  assert(
    !JSON.stringify({ message: error.message, recovery: error.recovery }).includes(value),
    'never the value',
  );
  return true;
}

for (const visibility of ['public', 'private'])
  test(`J29-1 ${visibility} project: a save holding a credential is refused before any upload, and the fixed save lands its bytes`, async t => {
    const s = await resolutionFixture(t);
    s.f.patch('hostedProjects', s.f.projectId, { visibility });
    await s.transport().dispatch('open', { laneId: s.f.lane.laneId });
    const value = githubToken();
    writeFileSync(
      join(s.root, 'config.ts'),
      `export const name = 'app';\nexport const token = '${value}';\n`,
    );
    const objects = s.f.c.objects.size,
      before = s.calls.length;
    const command = { operationId: randomUUID(), message: 'Add config' };
    let cli;
    await assert.rejects(s.transport().dispatch('save', command), error =>
      refused((cli = error), value, 'config.ts'),
    );
    // Not a dotenv file: the value belongs in sealed secrets by name (Item 41a0df87 slice 3).
    assert.match(cli.message, /Remove it \(keep the value in sealed secrets with nforge secret set NAME\)/);
    // MCP runs the same client: the same code, finding, next step and value-free text.
    const tools = new Map();
    t.after(
      registerHostedAgentWorkflow(
        { registerTool: (name, config, call) => tools.set(name, { config, call }) },
        s.transport(),
      ),
    );
    const mcp = await tools
      .get('forge_task')
      .call({ command: { action: 'save', ...command } }, { signal: new AbortController().signal });
    assert.equal(mcp.isError, true);
    const { error } = JSON.parse(mcp.content[0].text);
    assert.equal(error.code, 'SECRET_FOUND');
    assert.equal(error.message, cli.message);
    assert.deepEqual(error.recovery.findings, cli.recovery.findings);
    assert.deepEqual(error.recovery.next, cli.recovery.next);
    assert(!mcp.content[0].text.includes(value), 'never the value');
    assert.deepEqual(uploads(s.calls.slice(before)), [], 'no save, object or job call before either refusal');
    assert.equal(s.f.c.objects.size, objects, 'no byte stored');
    assert(!existsSync(join(clientCacheRoot(s.root), 'saves', command.operationId)), 'capture dropped');
    // Removed and rotated: the same command now captures the fixed file afresh and saves it.
    writeFileSync(
      join(s.root, 'config.ts'),
      `export const name = 'app';\nexport const token = process.env.TOKEN;\n`,
    );
    const saved = await s.transport().dispatch('save', command);
    assert.equal(saved.result.status ?? saved.result.outcome?.status ?? 'completed', 'completed');
    assert(s.f.c.objects.size > objects, 'the fixed save stores its bytes');
  });

async function allowFixture(t, where) {
  const value = githubToken(),
    path = 'fixtures/token.txt',
    entry = {
      fingerprint: secretFingerprint(path, 'github-token', value),
      path,
      reason: 'Synthetic test token',
    };
  const s = await resolutionFixture(t, {
    baselineFiles: [['.forge-secret-allow.json', JSON.stringify({ allow: where === 'main' ? [entry] : [] })]],
  });
  await s.transport().dispatch('open', { laneId: s.f.lane.laneId });
  // The Lane's base State, as an open of a Lane with saves leaves it on a machine that synced it.
  const base = readHostedLaneCheckout(s.root).selection.base.head;
  const cache = join(clientCacheRoot(s.root), 'objects');
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, base), s.f.c.objects.get(base));
  mkdirSync(join(s.root, 'fixtures'), { recursive: true });
  writeFileSync(join(s.root, path), `fixture\n${value}\n`);
  // The Lane adds the matching entry in the same save: it does not count until it is on main.
  if (where === 'self')
    writeFileSync(join(s.root, '.forge-secret-allow.json'), JSON.stringify({ allow: [entry] }));
  return { s, value, path };
}

test('J29-2: a fixture allowed on main saves; the same entry added only by the Lane does not count (R-01)', async t => {
  const allowed = await allowFixture(t, 'main');
  const objects = allowed.s.f.c.objects.size;
  await allowed.s.transport().dispatch('save', { operationId: randomUUID(), message: 'Add fixture' });
  assert(allowed.s.f.c.objects.size > objects, 'the allowed fixture is saved');
  const self = await allowFixture(t, 'self');
  await assert.rejects(
    self.s.transport().dispatch('save', { operationId: randomUUID(), message: 'Add fixture' }),
    error => {
      refused(error, self.value, self.path);
      assert.match(error.message, /1 finding\(s\) match an allow entry this Lane adds/);
      return true;
    },
  );
});

test('Item 41a0df87 slice 3: a credential in a tracked dotenv file names nforge secret import as the next step', async t => {
  // A new .env is never captured by name; a tracked one (here .env.development) is saved and scanned.
  const s = await resolutionFixture(t, { baselineFiles: [['.env.development', 'APP_NAME=app\n']] });
  await s.transport().dispatch('open', { laneId: s.f.lane.laneId });
  const value = githubToken();
  writeFileSync(join(s.root, '.env.development'), `APP_NAME=app\nGITHUB_TOKEN=${value}\n`);
  await assert.rejects(
    s.transport().dispatch('save', { operationId: randomUUID(), message: 'Add env' }),
    error => {
      refused(error, value, '.env.development');
      assert.match(
        error.message,
        /Move it into sealed secrets with nforge secret import '?\S*\/\.env\.development'? \(it removes the file\)/,
      );
      return true;
    },
  );
});
