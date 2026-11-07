// SPDX-License-Identifier: Apache-2.0
// B1.5d agent runner: one agent CLI, model and flag set for both arms (config.agent), in a
// macOS sandbox. Codex (GPT) is the run's agent; Claude Code stays selectable. Writes are
// limited to the workspace (plus the CLI's own caches); bench data (tasks, oracle, results,
// other workspaces) is unreadable. `scripted` replaces the model for the no-model dry run.
import { spawn } from 'node:child_process';
import {
  createWriteStream,
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  lstatSync,
  readdirSync,
  copyFileSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const AGENTS = {
  claude: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'cli-default' },
  codex: { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
};
export const MODEL = AGENTS.claude.model;
export const CLAUDE = process.env.BENCH_CLAUDE || join(homedir(), '.npm-global/bin/claude');
export const CODEX = process.env.BENCH_CODEX || '/opt/homebrew/bin/codex';
/** The configured agent; Codex when config.agent is absent (the run's recorded choice). */
export const agentOf = config => ({ ...AGENTS[config?.agent?.provider ?? 'codex'], ...config?.agent });
// Codex tools beyond shell, patch and plan, off for the same reasons Claude runs without
// WebFetch/WebSearch/Agent/Task: no web, no sub-agents, no browser/computer/apps/plugins.
export const CODEX_DISABLED = [
  'multi_agent',
  'image_generation',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'in_app_browser',
  'apps',
  'plugins',
  'remote_plugin',
  'hooks',
  'tool_suggest',
  'skill_search',
  'goals',
  'memories',
];
const CODEX_HOMES = join(homedir(), '.codex-bench');

/** Deny reads of bench data outside this workspace; allow writes to it and tool caches. */
export function sandboxProfile({
  workspace,
  benchRoot,
  extraWrites = [],
  extraReads = [],
  codexHome = null,
}) {
  // extraWrites (e.g. the git hub holding a worktree's objects) are readable too.
  const home = homedir();
  // A Codex agent reads only its own CODEX_HOME (its auth file links to the owner's): never
  // the owner's Codex or Claude sessions, nor another task's home.
  const codex = codexHome
    ? { denies: [join(home, '.codex'), join(home, '.claude'), CODEX_HOMES], reads: [codexHome] }
    : { denies: [], reads: [] };
  const writes = [
    ...(codexHome ? [codexHome] : []),
    workspace,
    workspace + '.forge-client',
    join(home, '.claude'),
    join(home, '.claude.json'),
    join(home, '.cache'),
    join(home, '.local/share/vite-plus'),
    join(home, '.config/vite-plus'),
    join(home, '.local/share/pnpm'),
    join(home, 'Library/pnpm'),
    join(home, 'Library/Caches'),
    join(home, '.npm'),
    join(home, '.config/forge'),
    join(home, '.config/gh'),
    '/private/tmp',
    '/private/var/folders',
    '/dev/null',
    '/dev/tty',
    ...extraWrites,
  ];
  const denies = [
    benchRoot,
    // Sibling checkouts and agent workspaces next to the bench data (owner layout).
    ...['forge-bench/results', 'nanthai-forge', 'forge-phase5', 'forge-hosted'].map(name =>
      join(dirname(dirname(benchRoot)), name),
    ),
    ...codex.denies,
  ];
  // Node resolves a script's realpath by lstat-ing every parent, so readable paths under
  // a denied root (the CLI in forge-phase5) need metadata on their ancestors (no contents).
  const ancestors = new Set();
  for (const p of [...extraWrites, ...extraReads, ...codex.reads])
    for (let d = dirname(p); d !== dirname(d); d = dirname(d)) ancestors.add(d);
  const q = JSON.stringify;
  return `(version 1)
(allow default)
(deny file-write*)
(allow file-write* ${writes.map(p => `(subpath ${q(p)})`).join(' ')})
(deny file-read* ${denies.map(p => `(subpath ${q(p)})`).join(' ')})
(allow file-read-metadata (subpath ${q(benchRoot)})${[...ancestors].map(p => ` (literal ${q(p)})`).join('')})
(allow file-read* (subpath ${q(workspace)}) (subpath ${q(workspace + '.forge-client')}) (subpath ${q(dirname(workspace) + '/bin')}) ${[...extraWrites, ...extraReads, ...codex.reads].map(p => `(subpath ${q(p)})`).join(' ')})
${codexHome ? `(allow file-read* file-write* (literal ${q(join(home, '.codex/auth.json'))}))\n` : ''}`;
}

/** Usage of the whole session (S1): `modelUsage` totals every turn and model, including
 * turns after background-task notifications; the top-level `usage` covers the last turn
 * only (kept as lastTurn for audit). Missing values stay null. */
export function usage(stdout) {
  try {
    const result = JSON.parse(stdout.trim().split('\n').at(-1));
    const models = Object.values(result.modelUsage ?? {});
    const sum = key => (models.length ? models.reduce((a, m) => a + (m[key] ?? 0), 0) : null);
    const u = result.usage ?? {};
    return {
      sessionId: result.session_id ?? null,
      isError: Boolean(result.is_error),
      subtype: result.subtype ?? null,
      numTurns: result.num_turns ?? null,
      durationMs: result.duration_ms ?? null,
      durationApiMs: result.duration_api_ms ?? null,
      models: Object.keys(result.modelUsage ?? {}),
      inputTokens: sum('inputTokens'),
      cacheCreationInputTokens: sum('cacheCreationInputTokens'),
      cacheReadInputTokens: sum('cacheReadInputTokens'),
      outputTokens: sum('outputTokens'),
      costUsdEquivalent: result.total_cost_usd ?? null,
      lastTurn: {
        inputTokens: u.input_tokens ?? null,
        cacheCreationInputTokens: u.cache_creation_input_tokens ?? null,
        cacheReadInputTokens: u.cache_read_input_tokens ?? null,
        outputTokens: u.output_tokens ?? null,
      },
    };
  } catch {
    return { sessionId: null, parseError: true };
  }
}

const jsonLines = text =>
  String(text ?? '')
    .split('\n')
    .filter(line => line.startsWith('{'))
    .flatMap(line => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });

/** Usage of a whole Codex run, in the Claude fields: the rollout's thread total covers every
 * model request of the session (`numTurns` counts those requests, as Claude's num_turns counts
 * assistant turns); `codex exec --json` turn totals are the fallback and the cross-check.
 * OpenAI input counts include cached input: `inputTokens` is the uncached part. */
export function codexUsage(stdout, rollout = '') {
  const events = jsonLines(stdout),
    entries = jsonLines(rollout);
  const turns = events.filter(e => e.type === 'turn.completed');
  const sum = key => turns.reduce((a, e) => a + (e.usage?.[key] ?? 0), 0);
  const counts = entries.filter(e => e.type === 'event_msg' && e.payload?.type === 'token_count');
  const total = counts.findLast(e => e.payload.info?.total_token_usage)?.payload.info.total_token_usage;
  const requests = entries.filter(e => e.type === 'token_usage_record').length;
  const u = total ?? {
    input_tokens: sum('input_tokens'),
    cached_input_tokens: sum('cached_input_tokens'),
    output_tokens: sum('output_tokens'),
    reasoning_output_tokens: sum('reasoning_output_tokens'),
  };
  const errors = events
    .filter(e => e.type === 'error' || e.type === 'turn.failed')
    .map(e => String(e.message ?? e.error?.message ?? JSON.stringify(e)).slice(0, 500));
  const meta = entries.find(e => e.type === 'session_meta')?.payload;
  if (!total && !turns.length) return { sessionId: meta?.id ?? null, parseError: true, errors };
  return {
    sessionId: meta?.id ?? events.find(e => e.type === 'thread.started')?.thread_id ?? null,
    isError: errors.length > 0 || !turns.length,
    errors,
    source: total ? 'rollout' : 'exec-json',
    numTurns: requests || counts.filter(e => e.payload.info?.last_token_usage).length || turns.length,
    execTurns: turns.length,
    durationApiMs: null,
    models: [...new Set(entries.filter(e => e.type === 'turn_context').map(e => e.payload?.model))],
    efforts: [...new Set(entries.filter(e => e.type === 'turn_context').map(e => e.payload?.effort))],
    totalInputTokens: u.input_tokens ?? null,
    inputTokens: (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0),
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: u.cached_input_tokens ?? null,
    outputTokens: u.output_tokens ?? null,
    reasoningOutputTokens: u.reasoning_output_tokens ?? null,
    execJsonTotals: turns.length
      ? { input: sum('input_tokens'), cached: sum('cached_input_tokens'), output: sum('output_tokens') }
      : null,
    rateLimits: counts.findLast(e => e.payload.rate_limits)?.payload.rate_limits ?? null,
  };
}

const QUOTA =
  /usage limit|rate[_ -]limit|hit your (usage )?limit|\b429\b|at capacity|server_overloaded|overloaded|usage_limit_reached|insufficient_quota|quota exceeded/i;

/** Usage, rate or provider-capacity stop: CLI errors only (agent prose can mention limits), or a Codex
 * rate-limit window at 100%. */
export function quotaHit({ provider, stdout, stderr, usage: u }) {
  if (provider === 'codex')
    return (
      QUOTA.test(stderr) ||
      (u?.errors ?? []).some(e => QUOTA.test(e)) ||
      [u?.rateLimits?.primary, u?.rateLimits?.secondary].some(w => (w?.used_percent ?? 0) >= 100)
    );
  // Claude result errors are structured; never scan assistant prose in stdout.
  return (
    QUOTA.test(stderr) ||
    jsonLines(stdout).some(e =>
      e.type === 'error' || e.type === 'turn.failed'
        ? QUOTA.test(String(e.message ?? e.error?.message ?? JSON.stringify(e.error)))
        : e.type === 'result' && e.is_error && QUOTA.test(JSON.stringify(e.errors ?? e.error ?? '')),
    )
  );
}

/** A fresh CODEX_HOME per task: no owner config, AGENTS.md, skills, plugins or sessions;
 * auth.json is a link to the owner's (never read here). */
function codexHomeFor() {
  const dir = join(CODEX_HOMES, randomUUID());
  mkdirSync(dir, { recursive: true });
  symlinkSync(join(homedir(), '.codex/auth.json'), join(dir, 'auth.json'));
  return dir;
}

/** Keep the rollout, return a token refresh to the owner's file, delete the home. */
function closeCodexHome(dir, prefix) {
  const found = [];
  const walk = d => {
    for (const e of existsSync(d) ? readdirSync(d, { withFileTypes: true }) : [])
      if (e.isDirectory()) walk(join(d, e.name));
      else if (/^rollout-.*\.jsonl$/.test(e.name)) found.push(join(d, e.name));
  };
  walk(join(dir, 'sessions'));
  let transcript = null;
  if (found.length) {
    // One exec, one rollout; several would mean a resumed or forked thread: keep them all.
    writeFileSync(
      prefix + '.transcript.jsonl',
      found
        .sort()
        .map(f => readFileSync(f, 'utf8'))
        .join(''),
      {
        flag: 'wx',
      },
    );
    transcript = prefix + '.transcript.jsonl';
  }
  // Codex may replace the link with a refreshed file (write-then-rename): move it back.
  const auth = join(dir, 'auth.json');
  let authRefreshed = false;
  if (existsSync(auth) && !lstatSync(auth).isSymbolicLink()) {
    renameSync(auth, join(homedir(), '.codex/auth.json'));
    authRefreshed = true;
  }
  rmSync(dir, { recursive: true, force: true });
  return { transcript, rollouts: found.length, authRefreshed };
}

/** `codex exec` with the run's model and effort and the same limits as the Claude flags. */
export function codexArgs({ model, effort, workspace, prompt }) {
  return [
    'exec',
    '--json',
    '--model',
    model,
    '-c',
    `model_reasoning_effort="${effort}"`,
    '-c',
    'web_search="disabled"',
    // Commands run in a non-login shell that inherits the harness PATH (relay shim and
    // /usr/local/bin first); a login shell would rebuild PATH from the owner's profile.
    '-c',
    'allow_login_shell=false',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    // The macOS profile around the process is the sandbox (sandbox-exec cannot nest).
    '--dangerously-bypass-approvals-and-sandbox',
    ...CODEX_DISABLED.flatMap(f => ['--disable', f]),
    '-C',
    workspace,
    '--',
    prompt,
  ];
}

/** Launch one agent session. Resolves with a receipt; never throws for agent failure. */
// Agents run detached (their own process group, so a timeout kills the whole tree); a
// crashing harness kills what is still running here before it exits.
const live = new Set();
/** Kill every running agent's process group; returns how many were running. */
export function killAgents() {
  const n = live.size;
  for (const pid of live)
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {}
  live.clear();
  return n;
}

export function launchAgent({
  workspace,
  benchRoot,
  prefix,
  prompt,
  env,
  timeoutMs,
  scripted,
  agent = AGENTS.codex,
  extraWrites = [],
  extraReads = [],
}) {
  mkdirSync(dirname(prefix), { recursive: true });
  writeFileSync(prefix + '.prompt.txt', prompt, { flag: 'wx' });
  const codex = !scripted && agent.provider === 'codex';
  const codexHome = codex ? codexHomeFor() : null;
  const profile = prefix + '.sb';
  writeFileSync(profile, sandboxProfile({ workspace, benchRoot, extraWrites, extraReads, codexHome }));
  const id = randomUUID();
  const args = scripted
    ? scripted.args
    : codex
      ? codexArgs({ model: agent.model, effort: agent.effort, workspace, prompt })
      : [
          '-p',
          '--output-format',
          'json',
          '--model',
          agent.model,
          '--dangerously-skip-permissions',
          '--setting-sources',
          '',
          '--strict-mcp-config',
          '--mcp-config',
          '{"mcpServers":{}}',
          '--disable-slash-commands',
          '--disallowedTools',
          'WebFetch,WebSearch,Agent,Task',
          '--session-id',
          id,
          prompt,
        ];
  const command = scripted ? scripted.command : codex ? CODEX : CLAUDE;
  const childEnv = {
    ...process.env,
    ...env,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    ...(codexHome ? { CODEX_HOME: codexHome } : {}),
  };
  for (const key of Object.keys(childEnv))
    if (
      key.startsWith('T3_') ||
      key === 'CLAUDECODE' ||
      key.startsWith('CLAUDE_CODE_ENTRYPOINT') ||
      (key.startsWith('CODEX_') && key !== 'CODEX_HOME')
    )
      delete childEnv[key];
  const started = Date.now();
  const stdout = createWriteStream(prefix + '.stdout.json', { flags: 'wx' });
  const stderr = createWriteStream(prefix + '.stderr.txt', { flags: 'wx' });
  const child = spawn('/usr/bin/sandbox-exec', ['-f', profile, command, ...args], {
    cwd: workspace,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  live.add(child.pid);
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  let killed = null;
  const timer = setTimeout(() => {
    killed = 'timeout';
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
  }, timeoutMs);
  return new Promise(resolve =>
    child.on('close', async (code, signal) => {
      live.delete(child.pid);
      clearTimeout(timer);
      await Promise.all([new Promise(r => stdout.end(r)), new Promise(r => stderr.end(r))]);
      const out = readFileSync(prefix + '.stdout.json', 'utf8'),
        err = readFileSync(prefix + '.stderr.txt', 'utf8');
      let home = null;
      try {
        home = codexHome ? closeCodexHome(codexHome, prefix) : null;
      } catch (error) {
        home = { error: String(error.message).slice(0, 300) };
      }
      const rollout = home?.transcript ? readFileSync(home.transcript, 'utf8') : '';
      const u = scripted ? null : codex ? codexUsage(out, rollout) : usage(out);
      const receipt = {
        provider: scripted ? 'scripted' : agent.provider,
        model: scripted ? 'scripted-no-model' : agent.model,
        // Claude: no --effort flag and no settings sources, the CLI default effort.
        effort: scripted ? null : agent.effort,
        sessionId: scripted ? null : codex ? (u.sessionId ?? null) : id,
        transcript: home?.transcript ?? null,
        codexHome: home
          ? { rollouts: home.rollouts, authRefreshed: home.authRefreshed, error: home.error }
          : undefined,
        startedAt: new Date(started).toISOString(),
        elapsedSeconds: (Date.now() - started) / 1000,
        exitCode: code,
        signal,
        killed,
        usage: u,
      };
      receipt.quotaHit =
        !scripted && quotaHit({ provider: agent.provider, stdout: out, stderr: err, usage: u });
      writeFileSync(prefix + '.session.json', JSON.stringify(receipt, null, 1) + '\n', { flag: 'wx' });
      resolve(receipt);
    }),
  );
}
