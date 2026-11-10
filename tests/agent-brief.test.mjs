// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { BRIEF_SITUATIONS, briefInputSchema } from '../dist/agent-brief-types.js';
import { COPY_TEXT_CAP, FULL_BRIEF_CAP, renderBriefing } from '../dist/agent-brief-render.js';
import { instructionFiles, briefingContext } from '../dist/agent-brief-context.js';
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
      assert.match(actual.full, /Native owners can read peers\/presence/);
      assert.match(actual.full, /Hosted peers\/diff are unavailable/);
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
