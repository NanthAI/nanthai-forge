// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Guard 2 of Item 368ac54f (bug class: Item b574ed11, receipt b42fa8cc).
//
// A test that only passes when no agent is the parent process fails on a builder's machine (the
// agent's CLI is the parent there) but passes in CI (no agent parent). This runs the agent-session
// test family once more under a simulated Claude Code parent and once under a simulated Codex
// parent, so the same failure shows up in the landing check.
//
// The simulation uses the inputs the detection code reads (src/agent-session.ts,
// src/agent-client-process.ts): the executable name of the nearest ancestor process and the
// client's own session variable. The parent is this Node binary behind a symlink named `claude` or
// `codex` with a matching process title (the same fixture agent-session-process.test.mjs uses), so
// the process-tree walk is real and nothing is spawned beyond one Node process per harness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const here = 'tests/agent-parent-simulated.test.mjs';

// Fast tests that read, clear or depend on the agent parent or its session variables.
const FAMILY = [
  'tests/agent-client-process.test.mjs',
  'tests/agent-run-identity.test.mjs',
  'tests/agent-session-process.test.mjs',
  'tests/agent-session.test.mjs',
  'tests/agent-slug.test.mjs',
  'tests/hosted-conversation.test.mjs',
  'tests/hosted-land-acceptance-wait.test.mjs',
  'tests/hosted-wait-papercuts.test.mjs',
  'tests/lane-holder.test.mjs',
  'tests/mcp-client-lifecycle.test.mjs',
  'tests/secret-run-names.test.mjs',
  'tests/secret-run.test.mjs',
];

// Tests that touch the same inputs but are left out of the simulated run. Each is slow (over about
// 2.5 s) or only builds fixtures, and runs in the normal suite; list a new one here only with its reason.
const EXCLUDED = {
  'tests/coordination-counts.test.mjs':
    'slow (1.5 s); clears one session variable, coordination counts are the subject',
  'tests/hosted-agent-start-placement.test.mjs': 'imports the session module only; placement is the subject',
  'tests/agent-turn-end-hook.test.mjs': 'slow (4 s); turn-end wake hook',
  'tests/cli-held-land.test.mjs': 'slow (9 s); forces foreground mode for the measurement hold CLI cases',
  'tests/hosted-agent-cli.test.mjs': 'slow (3.4 s); CLI verbs',
  'tests/hosted-agent-mcp.test.mjs': 'slow (4.5 s); MCP verbs',
  'tests/source-authorship.test.mjs': 'slow (2.7 s); authorship record',
  'tests/bench-t3code-plan.test.mjs': 'slow (35 s); bench planning, not the agent session path',
  'tests/hosted-agent-planning.test.mjs': 'slow (20 s); planning verbs',
  'tests/hosted-agent-withdraw.test.mjs': 'slow (12 s); withdraw verb',
  'tests/hosted-submission-wait.test.mjs': 'slow (9 s); wake on a submission',
  'tests/bench-t3code-replay-adapters.test.mjs': 'sets FORGE_AGENT_SESSION only to name replay agents',
  'tests/planning-audit-trail.test.mjs': 'slow (7 s); Item audit trail and model attribution',
};

// The inputs the detection code reads, and the modules that read them.
const INPUTS =
  /resolveAgentSession|nearestAgentProcess|agentClientProcess|detectedClientProcess|sessionAgentSlug|backgroundWake|CLAUDE_CODE_SESSION_ID|CODEX_THREAD_ID|FORGE_AGENT_WAKE|agent-wake|agent-session|agent-client-process/;

const HARNESSES = [
  { name: 'claude', variable: 'CLAUDE_CODE_SESSION_ID' },
  { name: 'codex', variable: 'CODEX_THREAD_ID' },
];
const SESSION_VARIABLES = [
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_THREAD_ID',
  'PI_SESSION_ID',
  'OPENCODE_SESSION_ID',
  'T3CODE_THREAD_ID',
  'GEMINI_SESSION_ID',
  'CRUSH_SESSION_ID',
  'QWEN_CODE_SESSION_ID',
  'FORGE_AGENT_SESSION',
  'FORGE_AGENT_WAKE',
  'FORGE_HUMAN',
  'FORGE_CLIENT_SETTINGS',
];

test('every test that reads the agent parent or session is in the simulated-parent run or excluded with a reason', () => {
  const listed = new Set([...FAMILY, ...Object.keys(EXCLUDED), here]);
  const unlisted = readdirSync(join(root, 'tests'))
    .filter(name => name.endsWith('.test.mjs'))
    .map(name => `tests/${name}`)
    .filter(path => !listed.has(path) && INPUTS.test(readFileSync(join(root, path), 'utf8')));
  assert.deepEqual(
    unlisted,
    [],
    'add each to FAMILY in tests/agent-parent-simulated.test.mjs, or to EXCLUDED with the reason',
  );
  for (const path of listed) readFileSync(join(root, path), 'utf8');
});

for (const harness of HARNESSES) {
  test(
    `agent-session family passes under a simulated ${harness.name} parent`,
    { skip: process.platform === 'win32' || process.env.FORGE_AGENT_PARENT_SIM },
    async t => {
      const dir = mkdtempSync(join(tmpdir(), 'forge-agent-parent-'));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      const executable = join(dir, harness.name);
      symlinkSync(process.execPath, executable);
      const env = { ...process.env };
      for (const variable of SESSION_VARIABLES) delete env[variable];
      env[harness.variable] = `simulated-${harness.name}-session`;
      env.FORGE_AGENT_PARENT_SIM = harness.name;
      // Inside this run Node marks its children as subtests; the family needs a runner of its own.
      delete env.NODE_TEST_CONTEXT;
      // The parent only names itself (Linux reports the Node binary behind a symlink, so the title
      // carries the name) and then runs the family as its child, like an agent starting a shell.
      const client = `import {spawnSync} from 'node:child_process';process.title=${JSON.stringify(harness.name)};const r=spawnSync(process.execPath,['--import','./tests/check-runtime.mjs','--test',...${JSON.stringify(FAMILY)}],{cwd:${JSON.stringify(root)},encoding:'utf8',maxBuffer:64<<20});process.stdout.write(r.stdout+r.stderr);process.exit(r.status??1);`;
      const child = spawn(executable, ['--input-type=module', '-e', client], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', data => (output += data));
      child.stderr.on('data', data => (output += data));
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });
      const failed = [...output.matchAll(/^\s*✖ (.+?) \(/gm)].map(match => match[1]);
      assert.equal(
        code,
        0,
        `${failed.length ? `failing under a ${harness.name} parent: ${[...new Set(failed)].join('; ')}\n` : ''}${output.slice(-6000)}`,
      );
    },
  );
}
