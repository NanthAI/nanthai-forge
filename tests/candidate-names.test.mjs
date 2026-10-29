// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { initNative } from '../dist/native-work.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { candidateActions, candidateCommand } from '../dist/candidate-names.js';
import { fixture, git } from './helpers.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { callTool, mcpTestEnvironment, requestOptions } from './mcp-runtime.mjs';
const cliPath = resolve('dist/cli.js');
const invoke = (...args) => spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
function success(...args) {
  const result = invoke(...args);
  assert.equal(result.status, 0, result.stderr);
  return result;
}
async function setup(t, engine = 'native') {
  const root =
    engine === 'git'
      ? fixture(t, { 'a.ts': 'export const a = 1;\n' })
      : mkdtempSync(join(tmpdir(), 'forge-candidate-'));
  if (engine === 'native') {
    t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    initNative(root);
  } else {
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'Synthetic base']);
  }
  const agent = new AgentWorkflow(root);
  const lane = (await agent.dispatch({ action: 'start', outcome: 'Synthetic Candidate' })).result;
  const candidate = (
    await agent.dispatch({
      action: 'compose',
      operationId: randomUUID(),
      intentId: lane.intentId,
      inputs: [{ laneId: lane.laneId, head: lane.head }],
    })
  ).result;
  return { root, agent, lane, candidate };
}
for (const engine of ['native', 'git']) {
  test(`${engine} CLI Candidate reads preserve identical JSON; View notices use stderr only`, async t => {
    const { root, lane, candidate } = await setup(t, engine);
    for (const [old, current, input] of [
      ['view', 'candidate', { viewId: candidate.viewId }],
      ['views', 'candidates', { laneId: lane.laneId }],
    ]) {
      const oldResult = success('agent', root, old, JSON.stringify({ action: old, ...input }));
      const newResult = success('agent', root, current, JSON.stringify({ action: current, ...input }));
      assert.equal(oldResult.stdout, newResult.stdout);
      assert.equal(oldResult.stderr, `Deprecated: ${old} is an alias for ${current}; use ${current}.\n`);
      assert.equal(newResult.stderr, '');
      assert.doesNotThrow(() => JSON.parse(oldResult.stdout));
      assert.doesNotMatch(oldResult.stdout, /Deprecated/);
    }
    for (const family of ['pr', 'repo']) {
      const before = success(
        family,
        'view',
        ...(family === 'pr' ? [lane.laneId] : []),
        '--repo',
        root,
        '--json',
      );
      const after = success(
        family,
        'candidate',
        ...(family === 'pr' ? [lane.laneId] : []),
        '--repo',
        root,
        '--json',
      );
      assert.equal(before.stdout, after.stdout);
      assert.match(before.stderr, /^Deprecated: view /);
      assert.equal(after.stderr, '');
    }
    const input = {
      viewId: candidate.viewId,
      expectedHead: candidate.head,
      otherViewId: candidate.viewId,
      otherHead: candidate.head,
    };
    const revision = String(agentRevision(root));
    const before = success('work', root, JSON.stringify({ action: 'compare-views', ...input }), revision);
    const after = success('work', root, JSON.stringify({ action: 'compare-candidates', ...input }), revision);
    assert.deepEqual(comparison(before.stdout), comparison(after.stdout));
    assert.match(before.stderr, /^Deprecated: compare-views /);
    assert.equal(after.stderr, '');
  });
}
function comparison(text) {
  const body = JSON.parse(text);
  assert.ok(Number.isFinite(Date.parse(body.result.observedAt)));
  delete body.result.observedAt; // Each read records its own observation time.
  return body;
}
function agentRevision(root) {
  return JSON.parse(success('agent', root, 'status').stdout).revision;
}
test('Candidate help is current, aliases show the same help and one notice', () => {
  for (const [old, current] of [
    ['view', 'candidate'],
    ['views', 'candidates'],
  ]) {
    const before = success('agent', '/unused/help-only', old, '--help');
    const after = success('agent', '/unused/help-only', current, '--help');
    assert.equal(before.stdout, after.stdout);
    assert.equal(before.stderr.trim().split('\n').length, 1);
    assert.equal(after.stderr, '');
    assert.match(after.stdout, new RegExp(`nforge agent ROOT ${current} `));
  }
  assert.equal(
    success('agent', '/unused/help-only', 'candidate', '--help').stdout,
    `nforge agent ROOT candidate '{"viewId":"CANDIDATE_ID","offset":0,"limit":20}'\n`,
  );
  assert.match(success('agent', '--help').stdout, /records, candidate, provenance, candidates, review/);
  assert.match(success('--help').stdout, /compare-candidates.*clean Candidates/);
  assert.match(success('docs', 'quickstart').stdout, /Candidate \(formerly View\)/);
  assert.match(success('docs', 'agent').stdout, /candidate \{viewId\}/);
});
test('aliases normalize only actions; stored identifiers and parameter bytes remain stable', () => {
  for (const [old, current] of Object.entries(candidateActions)) {
    const input = {
      action: current,
      viewId: 'unchanged',
      dependencies: [{ kind: 'view', viewId: 'unchanged' }],
    };
    assert.deepEqual(candidateCommand(input), { ...input, action: old });
  }
  assert.equal(candidateCommand(null), null);
});
test('MCP advertises Candidate actions, retains deprecated aliases and returns notice-free identical results', async t => {
  const { root, lane, candidate } = await setup(t);
  for (const profile of ['--agent', '--work']) {
    const client = new Client({ name: 'candidate-alias-test', version: '1' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath, 'mcp', root, profile],
      stderr: 'pipe',
      env: mcpTestEnvironment(t),
    });
    await client.connect(transport, requestOptions('connect'));
    t.after(() => client.close());
    let stderr = '';
    transport.stderr?.on('data', bytes => {
      stderr += bytes;
    });
    const tools = (await client.listTools(undefined, requestOptions('listTools'))).tools;
    const name = profile === '--agent' ? 'forge_review' : 'forge_work_command';
    const tool = tools.find(tool => tool.name === name);
    assert.ok(tool);
    assert.match(tool.description, /deprecated aliases/);
    const schema = JSON.stringify(tool.inputSchema);
    const call = async command => {
      const response = await callTool(client, {
        name,
        arguments: { command, ...(profile === '--work' ? { revision: agentRevision(root) } : {}) },
      });
      assert.ok(!response.isError, JSON.stringify(response));
      assert.doesNotMatch(JSON.stringify(response), /Deprecated:/);
      return response;
    };
    if (profile === '--agent') {
      for (const [old, current, input] of [
        ['view', 'candidate', { viewId: candidate.viewId }],
        ['views', 'candidates', { laneId: lane.laneId }],
      ]) {
        assert.match(schema, new RegExp(`"${current}"`));
        assert.deepEqual(await call({ action: current, ...input }), await call({ action: old, ...input }));
      }
    } else {
      for (const name of ['review-candidate', 'compare-candidates', 'resolve-native-candidate'])
        assert.ok(schema.includes(name));
      const input = {
        viewId: candidate.viewId,
        expectedHead: candidate.head,
        otherViewId: candidate.viewId,
        otherHead: candidate.head,
      };
      assert.deepEqual(
        comparison((await call({ action: 'compare-candidates', ...input })).content[0].text),
        comparison((await call({ action: 'compare-views', ...input })).content[0].text),
      );
      for (const action of ['review-candidate', 'review-view']) {
        const response = await call({
          action,
          viewId: candidate.viewId,
          expectedHead: candidate.head,
          reviewer: 'Synthetic reviewer',
          decision: 'comment',
        });
        assert.equal(JSON.parse(response.content[0].text).result.viewId, candidate.viewId);
      }
    }
    assert.doesNotMatch(stderr, /Deprecated:/);
    await client.close();
  }
  assert.ok(readFileSync(resolve('docs/agents/workflow.md'), 'utf8').includes('otherViewId'));
});

test('native resolution aliases reconcile one original command identity and keep JSON/error codes', async t => {
  const { root, agent, lane } = await setup(t);
  const sibling = (
    await agent.dispatch({ action: 'start', intentId: lane.intentId, outcome: 'Conflicting edit' })
  ).result;
  const heads = [];
  for (const [item, value] of [
    [lane, 2],
    [sibling, 3],
  ]) {
    writeFileSync(join(item.path, 'a.ts'), `export const a = ${value};\n`);
    const checkpoint = (
      await agent.dispatch({ action: 'checkpoint', laneId: item.laneId, message: 'Synthetic edit' })
    ).result;
    heads.push({ laneId: item.laneId, head: checkpoint.head });
  }
  const conflict = (
    await agent.dispatch({
      action: 'compose',
      operationId: randomUUID(),
      intentId: lane.intentId,
      inputs: heads,
    })
  ).result;
  assert.equal(conflict.status, 'conflict');
  const input = {
    operationId: randomUUID(),
    viewId: conflict.viewId,
    laneId: lane.laneId,
    expectedHead: heads[0].head,
  };
  const revision = String(agentRevision(root));
  const file = join(root, 'command.json');
  writeFileSync(file, JSON.stringify({ action: 'resolve-native-candidate', ...input }));
  const resolved = success('work', root, '--command-file', file, revision);
  const replay = success('work', root, JSON.stringify({ action: 'resolve-native-view', ...input }), revision);
  assert.deepEqual(JSON.parse(resolved.stdout), JSON.parse(replay.stdout));
  assert.equal(resolved.stderr, '');
  assert.equal(
    replay.stderr,
    'Deprecated: resolve-native-view is an alias for resolve-native-candidate; use resolve-native-candidate.\n',
  );
  const json = JSON.parse(resolved.stdout);
  assert.equal(json.result.operation.id, input.operationId);
  assert.equal(json.result.resolution.viewId, input.viewId);
  assert.equal(
    agent.work.store.load().views.filter(view => view.operation?.id === input.operationId).length,
    1,
  );
  for (const action of ['candidate', 'view']) {
    const missing = invoke('agent', root, action, JSON.stringify({ viewId: randomUUID() }));
    assert.equal(missing.status, 1);
    const lines = missing.stderr.trim().split('\n');
    assert.equal(lines.length, action === 'view' ? 2 : 1);
    assert.deepEqual(JSON.parse(lines.at(-1)).error, { code: 'NOT_FOUND', message: 'Candidate not found.' });
  }
});
