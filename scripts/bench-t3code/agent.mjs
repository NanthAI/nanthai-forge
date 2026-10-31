// B1.5d agent runner: Claude Code headless (claude-sonnet-5-5) in a macOS sandbox,
// identical flags in both arms. Writes are limited to the workspace (plus the CLI's
// own caches); bench data (tasks, oracle, results, other workspaces) is unreadable.
// `scripted` replaces the model for the no-model dry run with the arm's land path.
import { spawn } from 'node:child_process';
import { createWriteStream, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const MODEL = 'claude-sonnet-5-5';
export const CLAUDE = process.env.BENCH_CLAUDE || join(homedir(), '.npm-global/bin/claude');

/** Deny reads of bench data outside this workspace; allow writes to it and tool caches. */
export function sandboxProfile({ workspace, benchRoot, extraWrites = [], extraReads = [] }) {
  // extraWrites (e.g. the git hub holding a worktree's objects) are readable too.
  const home = homedir();
  const writes = [
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
  ];
  const q = JSON.stringify;
  return `(version 1)
(allow default)
(deny file-write*)
(allow file-write* ${writes.map(p => `(subpath ${q(p)})`).join(' ')})
(deny file-read* ${denies.map(p => `(subpath ${q(p)})`).join(' ')})
(allow file-read-metadata (subpath ${q(benchRoot)}))
(allow file-read* (subpath ${q(workspace)}) (subpath ${q(workspace + '.forge-client')}) (subpath ${q(dirname(workspace) + '/bin')}) ${[...extraWrites, ...extraReads].map(p => `(subpath ${q(p)})`).join(' ')})
`;
}

/** Usage from the final `--output-format json` result; missing values stay null. */
export function usage(stdout) {
  try {
    const result = JSON.parse(stdout.trim().split('\n').at(-1));
    const u = result.usage ?? {};
    return {
      sessionId: result.session_id ?? null,
      isError: Boolean(result.is_error),
      subtype: result.subtype ?? null,
      numTurns: result.num_turns ?? null,
      durationMs: result.duration_ms ?? null,
      inputTokens: u.input_tokens ?? null,
      cacheCreationInputTokens: u.cache_creation_input_tokens ?? null,
      cacheReadInputTokens: u.cache_read_input_tokens ?? null,
      outputTokens: u.output_tokens ?? null,
      costUsdEquivalent: result.total_cost_usd ?? null,
    };
  } catch {
    return { sessionId: null, parseError: true };
  }
}

const QUOTA =
  /usage limit|rate[_ -]limit|hit your (usage )?limit|\b429\b|overloaded_error|usage_limit_reached/i;

/** Launch one agent session. Resolves with a receipt; never throws for agent failure. */
export function launchAgent({
  workspace,
  benchRoot,
  prefix,
  prompt,
  env,
  timeoutMs,
  scripted,
  extraWrites = [],
  extraReads = [],
}) {
  mkdirSync(dirname(prefix), { recursive: true });
  writeFileSync(prefix + '.prompt.txt', prompt, { flag: 'wx' });
  const profile = prefix + '.sb';
  writeFileSync(profile, sandboxProfile({ workspace, benchRoot, extraWrites, extraReads }));
  const id = randomUUID();
  const args = scripted
    ? scripted.args
    : [
        '-p',
        '--output-format',
        'json',
        '--model',
        MODEL,
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
  const command = scripted ? scripted.command : CLAUDE;
  const childEnv = { ...process.env, ...env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  for (const key of Object.keys(childEnv))
    if (key.startsWith('T3_') || key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_ENTRYPOINT'))
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
      clearTimeout(timer);
      await Promise.all([new Promise(r => stdout.end(r)), new Promise(r => stderr.end(r))]);
      const out = readFileSync(prefix + '.stdout.json', 'utf8'),
        err = readFileSync(prefix + '.stderr.txt', 'utf8');
      const receipt = {
        model: scripted ? 'scripted-no-model' : MODEL,
        startedAt: new Date(started).toISOString(),
        elapsedSeconds: (Date.now() - started) / 1000,
        exitCode: code,
        signal,
        killed,
        usage: scripted ? null : usage(out),
      };
      // Agent prose can mention rate limits; only CLI errors count as a quota hit.
      receipt.quotaHit =
        !scripted && (QUOTA.test(err) || (Boolean(receipt.usage?.isError) && QUOTA.test(out)));
      writeFileSync(prefix + '.session.json', JSON.stringify(receipt, null, 1) + '\n', { flag: 'wx' });
      resolve(receipt);
    }),
  );
}
