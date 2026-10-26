import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { BRIEF_SITUATIONS, briefInputSchema } from '../dist/agent-brief-types.js';
import { COPY_TEXT_CAP, FULL_BRIEF_CAP, renderBriefing } from '../dist/agent-brief-render.js';
import { instructionFiles, briefingContext } from '../dist/agent-brief-context.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { initNative } from '../dist/native-work.js';
import { localBrief } from '../dist/agent-brief-local.js';
import { setLocalGuidance, localGuidance } from '../dist/agent-guidance.js';
import { fixtureBrief, ids, records, states, head, main, guidance } from './agent-brief-fixture.mjs';
for (const situation of BRIEF_SITUATIONS)
  for (const agent of ['claude-code', 'codex', 'generic']) {
    test(`golden briefing: ${situation} / ${agent}`, () => {
      const actual = fixtureBrief(situation, agent);
      const expected = JSON.parse(
        readFileSync(new URL(`golden/briefings/${situation}.${agent}.json`, import.meta.url), 'utf8'),
      );
      assert.deepEqual(actual, expected);
      assert.ok(actual.copyText.length <= COPY_TEXT_CAP);
      assert.ok(actual.full.length <= FULL_BRIEF_CAP);
      assert.match(actual.copyText, /give Forge URLs \(from `link`\), not local paths/);
      assert.match(actual.full, /## Working on Forge, not GitHub/);
      assert.match(actual.full, /Never run the full suite locally/);
      assert.match(actual.full, /combined work of concurrent Lanes/);
      assert.match(actual.full, /failing Lane drops out and the others land after passing/);
      assert.match(actual.full, /Read peers\/presence/);
      assert.match(actual.full, /give Forge URLs \(from `link`\), not local paths/);
      assert.match(actual.copyText, /First run:.* brief /);
      assert.match(
        actual.full,
        /repository agent instruction files first; project guidance second; personal guidance third; Forge workflow steps last/,
      );
    });
  }
test('instruction detection names exact paths, handles case variants/nesting and excludes similar names', () => {
  const names = [
    'AGENTS.md',
    'src/agents.MD',
    'CLAUDE.md',
    'GEMINI.MD',
    '.windsurfRULES',
    '.CURSOR/RULES/team.mdc',
    '.cursor/rules/nested/a.md',
    '.GitHub/COPILOT-instructions.MD',
  ];
  assert.deepEqual(
    instructionFiles([
      ...names,
      'README.md',
      'fooAGENTS.md',
      'CLAUDE.md.txt',
      '.cursor/rules-old/a.md',
      '.cursor/rules',
      '.github/copilot-instructions.md.bak',
    ]),
    names.sort(),
  );
});
test('agent variants change only the agent tool/setup line and the variant passed to fresh brief', () => {
  const a = fixtureBrief('resolve-conflict', 'claude-code'),
    b = fixtureBrief('resolve-conflict', 'codex');
  assert.deepEqual(a.context, b.context);
  assert.deepEqual(a.setup, b.setup);
  const normalize = text =>
    text
      .replaceAll('claude-code', 'AGENT')
      .replaceAll('codex', 'AGENT')
      .replaceAll('Claude Code:', 'AGENT:')
      .replaceAll('Codex:', 'AGENT:');
  assert.equal(normalize(a.full), normalize(b.full));
  assert.equal(normalize(a.copyText), normalize(b.copyText));
});
test('copy/full sizes stay bounded with large structured records and guidance remains verbatim', () => {
  const result = fixtureBrief('continue-lane', 'generic'),
    context = structuredClone(result.context);
  context.paths = Array.from({ length: 10000 }, (_, i) => `src/${i}.ts`);
  context.instructionFiles = Array.from({ length: 10000 }, (_, i) => `pkg/${i}/AGENTS.md`);
  context.intent.notes = Array.from({ length: 5000 }, () => ({
    kind: 'comment',
    text: 'x'.repeat(4000),
    at: 'now',
  }));
  context.guidance = { project: 'P'.repeat(4000), personal: 'U'.repeat(4000) };
  const actual = renderBriefing(
    briefInputSchema.parse({ situation: 'continue-lane', laneId: ids.lane }),
    context,
    '/forge/demo',
    result.generatedAt,
  );
  assert.ok(actual.copyText.length <= COPY_TEXT_CAP);
  assert.ok(actual.full.length <= FULL_BRIEF_CAP);
  assert.ok(actual.full.includes(context.guidance.project));
  assert.ok(actual.full.includes(context.guidance.personal));
  assert.match(actual.full, /Presentation shortened/);
  const normalized = text =>
    text
      .replaceAll('Claude Code: use Forge MCP tools if configured.', 'TOOLS')
      .replaceAll('Codex: use Forge MCP tools if configured.', 'TOOLS')
      .replaceAll('Use Forge MCP tools if your agent supports them.', 'TOOLS')
      .replaceAll('claude-code', 'AGENT')
      .replaceAll('codex', 'AGENT')
      .replaceAll('generic', 'AGENT');
  for (const agent of ['claude-code', 'codex']) {
    const variant = renderBriefing(
      briefInputSchema.parse({ situation: 'continue-lane', laneId: ids.lane, agent }),
      context,
      '/forge/demo',
      result.generatedAt,
    );
    assert.equal(normalized(variant.copyText), normalized(actual.copyText));
    assert.equal(normalized(variant.full), normalized(actual.full));
  }
});
test('selection rejects cross-linked records and never infers merged state from missing ancestry', () => {
  assert.throws(
    () =>
      briefingContext(
        briefInputSchema.parse({ situation: 'continue-lane', laneId: ids.lane, intentId: ids.message }),
        records,
        id => states.get(id),
        guidance,
        () => '',
      ),
    { code: 'NOT_FOUND' },
  );
  const alternate = structuredClone(records);
  alternate.intents.push({ ...alternate.intents[0], id: ids.message });
  assert.throws(
    () =>
      briefingContext(
        briefInputSchema.parse({ situation: 'continue-lane', laneId: ids.lane, intentId: ids.message }),
        alternate,
        id => states.get(id),
        guidance,
        () => '',
      ),
    { code: 'BAD_ARGUMENT' },
  );
  const context = briefingContext(
    briefInputSchema.parse({ situation: 'continue-lane', laneId: ids.lane }),
    records,
    id => (id === main ? undefined : states.get(id)),
    guidance,
    () => '',
  );
  assert.equal(context.main.merged, null);
  const mergedStates = new Map(states);
  mergedStates.set(main, { ...states.get(main), parents: [head] });
  assert.equal(
    briefingContext(
      briefInputSchema.parse({ situation: 'continue-lane', laneId: ids.lane }),
      records,
      id => mergedStates.get(id),
      guidance,
      () => '',
    ).main.merged,
    true,
  );
});
function local(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-brief-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'AGENTS.md'), 'UNTRUSTED_REPOSITORY_TEXT_DO_NOT_ECHO');
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;');
  initNative(root);
  return { root, agent: new AgentWorkflow(root) };
}
test('local context reads checkpointed States, main changes and durable check summaries without source text', async t => {
  const { root, agent } = local(t);
  const started = (await agent.dispatch({ action: 'start', outcome: 'Fix the check' })).result;
  mkdirSync(join(started.path, '.cursor', 'rules'), { recursive: true });
  writeFileSync(join(started.path, '.cursor', 'rules', 'test.mdc'), 'ALSO_UNTRUSTED');
  writeFileSync(join(started.path, 'a.ts'), 'SECRET_SOURCE_BYTES');
  await agent.dispatch({ action: 'checkpoint', laneId: started.laneId, message: 'Candidate' });
  const brief = localBrief(agent.work.store, { situation: 'continue-lane', laneId: started.laneId });
  assert.deepEqual(brief.context.instructionFiles, ['.cursor/rules/test.mdc', 'AGENTS.md']);
  assert.deepEqual(brief.context.paths, ['.cursor/rules/test.mdc', 'a.ts']);
  assert.ok(!JSON.stringify(brief).includes('UNTRUSTED_REPOSITORY_TEXT'));
  assert.ok(!JSON.stringify(brief).includes('SECRET_SOURCE_BYTES'));
  const cli = spawnSync(
    process.execPath,
    [
      resolve('dist/cli.js'),
      'agent',
      root,
      'brief',
      JSON.stringify({ situation: 'continue-lane', laneId: started.laneId, agent: 'codex' }),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).situation, 'continue-lane');
  assert.equal(
    (await agent.dispatch({ action: 'brief', situation: 'continue-lane', laneId: started.laneId })).result
      .copyText,
    brief.copyText,
  );
});
test('local project/personal guidance is verbatim, retry-safe and bound to the local user', t => {
  const { agent } = local(t),
    store = agent.work.store;
  const first = { operationId: randomUUID(), scope: 'project', agentGuidance: '  project\nverbatim  ' };
  assert.deepEqual(setLocalGuidance(store, first, 'alice'), first);
  setLocalGuidance(store, { ...first, operationId: randomUUID(), agentGuidance: 'Latest project' }, 'alice');
  assert.deepEqual(setLocalGuidance(store, first, 'alice'), first);
  assert.equal(localGuidance(store, 'alice').project, 'Latest project');
  assert.throws(() => setLocalGuidance(store, { ...first, agentGuidance: 'changed' }, 'alice'), {
    code: 'WORK_OPERATION_CHANGED',
  });
  assert.throws(() => setLocalGuidance(store, first, 'bob'), { code: 'WORK_OPERATION_CHANGED' });
  setLocalGuidance(
    store,
    { operationId: randomUUID(), scope: 'personal', agentGuidance: 'Alice only' },
    'alice',
  );
  assert.equal(localGuidance(store, 'bob').personal, '');
  assert.throws(
    () => setLocalGuidance(store, { ...first, operationId: randomUUID(), agentGuidance: 'x'.repeat(4001) }),
    { code: 'BAD_ARGUMENT' },
  );
});

test('failed check summaries survive Work storage for hosted exchange and fresh briefing', async t => {
  const { agent } = local(t);
  const lane = (await agent.dispatch({ action: 'start', outcome: 'Diagnose failure' })).result;
  await agent.dispatch({
    action: 'define-check',
    name: 'verify',
    executable: process.execPath,
    args: [
      '-e',
      'console.error("Error: synthetic failure"); console.log("not ok 1 - synthetic check"); process.exit(1)',
    ],
    environmentLabel: 'Synthetic local test',
  });
  const finished = (
    await agent.dispatch({ action: 'finish', laneId: lane.laneId, message: 'Fail deliberately' })
  ).result;
  assert.equal(finished.run.status, 'failed');
  const run = agent.work.store.select('runs', finished.run.operationId);
  assert.match(run.failureSummary, /not ok 1 - synthetic check/);
  assert.match(run.failureSummary, /Error: synthetic failure/);
  const brief = localBrief(agent.work.store, { situation: 'fix-failed-check', runId: run.id });
  assert.equal(brief.context.run.failureSummary, run.failureSummary);
  assert.equal(brief.context.lane.path, agent.work.store.path(lane.laneId));
});
test('briefing rejects incomplete hosted bindings and source-only credentials without silently using local context', async t => {
  const { agent } = local(t);
  const lane = (await agent.dispatch({ action: 'start', outcome: 'Read context' })).result;
  const { agentBrief } = await import('../dist/agent-brief.js');
  const keys = ['FORGE_DEPLOYMENT', 'FORGE_PROJECT_ID', 'FORGE_AUTH_TOKEN'];
  const previous = keys.map(key => process.env[key]);
  t.after(() =>
    keys.forEach((key, i) =>
      previous[i] === undefined ? delete process.env[key] : (process.env[key] = previous[i]),
    ),
  );
  process.env.FORGE_DEPLOYMENT = 'https://synthetic.convex.cloud';
  delete process.env.FORGE_PROJECT_ID;
  await assert.rejects(agentBrief(agent.work.store, { situation: 'continue-lane', laneId: lane.laneId }), {
    code: 'BAD_ARGUMENT',
  });
  process.env.FORGE_PROJECT_ID = 'project';
  process.env.FORGE_AUTH_TOKEN = 'fga_source-only';
  await assert.rejects(agentBrief(agent.work.store, { situation: 'continue-lane', laneId: lane.laneId }), {
    code: 'PROJECT_UNAVAILABLE',
  });
});
