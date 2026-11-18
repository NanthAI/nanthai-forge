// SPDX-License-Identifier: Apache-2.0
// Getting started (Items 6beca32b, c3e4a838, 0c9207b8, 871e9b73): the agent app steps use only commands the CLI ships,
// the copied prompt explains before it installs, the setup rows say who did what, the one question is asked once, and
// the web's two setting writes have the shapes the server parses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';

globalThis.location ??= { origin: 'https://forge.example' };
const apps = await import(moduleUrl('../web/src/app/start/agent-apps.ts'));
const model = await import(moduleUrl('../web/src/app/start/setup-model.ts'));
const approvals = await import(moduleUrl('../web/src/app/start/approvals.ts'));
const ci = await import(moduleUrl('../web/src/app/checks/choose-ci.ts'));
const { hostedCheckRunnerSchema } = await import(moduleUrl('../src/hosted-check.ts'));
const { policyWriteSchema, legacyPolicy } = await import(moduleUrl('../src/autonomy-policy.ts'));
const { default: Start } = await import(moduleUrl('../web/src/app/start/Start.tsx'));
const { ConnectSteps } = await import(moduleUrl('../web/src/app/start/parts.tsx'));

const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
const verbs = readFileSync(new URL('../src/agent-verbs.ts', import.meta.url), 'utf8');
const commands = new Set([...cli.matchAll(/^ {2}nforge ([a-z][a-z-]*)/gm)].map(match => match[1]));
const DEPLOYMENT = 'https://example-123.convex.cloud';

test('every step for every agent app runs a command the CLI ships, and nothing from Phase 8', () => {
  for (const app of apps.agentApps)
    for (const project of [undefined, 'https://forge.example/someone/shop']) {
      const steps = apps.setupSteps(app, DEPLOYMENT, project);
      assert.equal(steps.filter(step => step.needsPerson).length, 1, 'the person acts once: the device');
      for (const line of steps.flatMap(step => step.commands)) {
        assert.doesNotMatch(line, /npm (install|i) -g|npx nforge/, 'no published package yet');
        assert.notEqual(line.trim(), 'nforge login', 'bare login is Phase 8');
        const forge = line.match(/^nforge ([a-z-]+)/);
        if (forge) assert.ok(commands.has(forge[1]), `nforge ${forge[1]} is in the CLI usage`);
        else
          assert.match(
            line,
            /^(git clone |cd |npm ci )/,
            `only the source install runs other tools: ${line}`,
          );
      }
      assert.ok(steps.some(step => step.commands.includes(`nforge login ${DEPLOYMENT}`)));
    }
  assert.ok(verbs.includes("'check-settings'"), 'the checks page names a verb agents have');
  assert.match(apps.setupSteps('other', DEPLOYMENT).at(-1).detail, /Hooks cover Claude Code and Codex only/);
});

test('no agent app is preselected: the shared steps show at once and the app is chosen in the last, optional step', () => {
  const html = renderToStaticMarkup(h(ConnectSteps, { deployment: DEPLOYMENT }));
  assert.equal([...html.matchAll(/aria-pressed="false"/g)].length, apps.agentApps.length);
  assert.doesNotMatch(html, /aria-pressed="true"/, 'every app is offered the same way');
  assert.ok(html.includes(`nforge login ${DEPLOYMENT}`), 'the steps every app shares need no choice');
  assert.doesNotMatch(html, /mcp-config|plugin-config/, 'no app’s tools step before the person picks');
  for (const app of apps.agentApps) {
    assert.deepEqual(
      apps.setupSteps(app, DEPLOYMENT).slice(0, -1),
      apps.sharedSteps(DEPLOYMENT),
      'apps differ only in the last step',
    );
    const last = apps.appStep(app);
    assert.equal(last.optional, true, 'commands alone need nothing more than the shared steps');
    assert.match(
      last.detail,
      /undo|remove/,
      'Forge writes no client configuration; the step says how to undo',
    );
  }
  assert.doesNotMatch(
    JSON.stringify(apps.sharedSteps(DEPLOYMENT).filter(step => !step.needsPerson)),
    /"detail"/,
    'a step the person only copies carries no standing explainer; its docs link explains',
  );
});

test('the steps link the install guide, hooks, MCP and guidance, each to a docs page and heading that exists', () => {
  const html = renderToStaticMarkup(h(ConnectSteps, { deployment: DEPLOYMENT }));
  const slug = text =>
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
  const hrefs = [...html.matchAll(/href="(\/docs\/[^"]*)"/g)].map(match => match[1]);
  for (const wanted of [
    '/docs/quickstart/#install-the-development-cli',
    '/docs/agents/workflow/#overlap-before-the-first-write',
    '/docs/agents/#connect-over-mcp',
    '/docs/agents/#copy-prompts-and-briefings',
    '/docs/guides/access/',
  ])
    assert.ok(hrefs.includes(wanted), `${wanted} is linked`);
  for (const href of hrefs) {
    const [page, anchor] = href.split('#');
    const source = readFileSync(new URL(`..${page.replace(/\/$/, '')}.md`, import.meta.url), 'utf8');
    if (anchor)
      assert.ok(
        [...source.matchAll(/^#{1,6} (.+)$/gm)].some(match => slug(match[1]) === anchor),
        `${href} names a heading of that page`,
      );
  }
});

test('Cursor gets the steps that work today: its terminal and the MCP entry, with no hooks promised', () => {
  const last = apps.setupSteps('cursor', DEPLOYMENT).at(-1);
  assert.deepEqual(last.commands, ['nforge mcp-config . --agent']);
  assert.match(last.detail, /\.cursor\/mcp\.json/);
  assert.match(last.detail, /no hooks to Cursor/);
  assert.match(
    last.detail,
    /remove that entry to undo/,
    'Forge writes no Cursor configuration; the person can undo',
  );
});

test('the sign-in step sends the person to the devices page where the same code and name show', () => {
  for (const app of apps.agentApps) {
    const signIn = apps.setupSteps(app, DEPLOYMENT).find(step => step.needsPerson);
    assert.equal(signIn.link.href, '/-/account/devices');
    assert.match(signIn.detail, /code matches/);
  }
});

test('the copied prompt makes the agent explain first, and is the landing page’s prompt', () => {
  const prompt = apps.explainFirstPrompt('https://forge.example');
  assert.match(prompt, /^Read https:\/\/forge\.example\/llms\.txt\./);
  assert.match(prompt, /Do not install anything yet\.$/);
  const landing = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.ok(landing.includes(prompt.split('\n').at(-1)), 'one prompt, not two drifting copies');
  assert.match(
    apps.joinPrompt('https://forge.example', 'https://forge.example/a/b'),
    /Tell me before anything/,
  );
});

test('the start page offers both doors without a Convex call or a claim that an agent started', () => {
  const html = renderToStaticMarkup(h(Start));
  assert.match(html, /Give this to your agent/);
  assert.match(html, /Import from GitHub/);
  assert.match(html, /Connect your agent app yourself/);
  assert.doesNotMatch(html, /agent (is )?(started|running)/i);
});

const view = (over = {}) => ({
  owner: 'ada',
  viewerIsOwner: true,
  created: { at: 1, by: 'ada' },
  repository: null,
  mirror: null,
  check: null,
  firstLanding: null,
  approvalsAnswered: false,
  ...over,
});
const states = steps => Object.fromEntries(steps.map(step => [step.id, step.state]));

test('setup rows record who and when, and point at the one next step', () => {
  const fresh = model.setupSteps(view(), 'shop', 0);
  assert.deepEqual(states(fresh), {
    import: 'done',
    repository: 'next',
    mirror: 'later',
    // Choosing a check never waits for GitHub: a project whose CI is not on GitHub has no mirror to turn on.
    check: 'next',
    agent: 'next',
    land: 'later',
  });
  assert.deepEqual([fresh[0].by, fresh[0].at], ['ada', 1]);
  const ready = model.setupSteps(
    view({
      repository: { fullName: 'someone/shop', at: 2, by: 'ada' },
      mirror: { repository: 'someone/shop', at: 3 },
      check: {
        kind: 'ci-file',
        repository: 'someone/shop',
        workflow: '.github/workflows/ci.yml',
        chosenAt: 4,
      },
    }),
    'shop',
    1,
  );
  assert.deepEqual(states(ready), {
    import: 'done',
    repository: 'done',
    mirror: 'done',
    check: 'done',
    agent: 'done',
    land: 'moving',
  });
  assert.equal(ready[3].fact, '.github/workflows/ci.yml, on someone/shop GitHub Actions');
  assert.deepEqual([ready[1].by, ready[1].at, ready[3].at], ['ada', 2, 4]);
});

test('after the first landing the owner is asked once who approves, then it goes away', () => {
  assert.equal(model.gettingStartedShown(view()), true);
  assert.equal(model.askWhoApproves(view()), false);
  const landed = view({ firstLanding: { at: 9 } });
  assert.equal(model.askWhoApproves(landed), true);
  assert.equal(model.askWhoApproves({ ...landed, viewerIsOwner: false }), false);
  assert.equal(model.gettingStartedShown({ ...landed, viewerIsOwner: false }), false);
  assert.equal(model.gettingStartedShown({ ...landed, approvalsAnswered: true }), false);
});

test('an approval answer changes only the acceptance mode, as a compare-and-swap the server parses', () => {
  const expected = legacyPolicy();
  const command = approvals.approvalCommand(crypto.randomUUID(), expected, 'review');
  const parsed = policyWriteSchema.parse(command);
  assert.deepEqual(parsed.acceptance, { mode: 'review' });
  assert.deepEqual(Object.keys(command).sort(), ['acceptance', 'action', 'expectedPolicy', 'operationId']);
  assert.match(approvals.approvalWords['auto-on-pass'].sub, /Protected paths still wait/);
});

test('choosing a CI file sends a runner setting the server parses, with no placeholder for a person', () => {
  assert.equal(ci.workflowProblem('.github/workflows/ci.yml'), null);
  assert.equal(ci.workflowProblem(' .github/workflows/test.yaml '), null);
  assert.match(ci.workflowProblem(''), /Type the workflow file/);
  assert.match(ci.workflowProblem('ci.yml'), /lives in \.github\/workflows/);
  const request = ci.ciFileRequest({
    operationId: crypto.randomUUID(),
    authorityEpoch: 3,
    expected: null,
    repository: 'someone/shop',
    workflow: ' .github/workflows/ci.yml ',
  });
  const runner = hostedCheckRunnerSchema.parse(request.change.configuration);
  assert.equal(runner.provider, 'ci-status');
  assert.equal(runner.ci.workflow, '.github/workflows/ci.yml');
  assert.equal(request.change.kind, 'runner');
  assert.match(ci.triggerLine, /forge\/candidates\/\*\*/);
});
