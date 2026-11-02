// Dry-agent protocol driver. Only public replies select recovery commands and roots.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

const friction = detail => {
  throw Error(`BENCH_PRODUCT_FRICTION: ${detail}`);
};

// Decode Forge's printed shell quoting without executing a shell or expanding source text.
export function printedCommand(text, cwd) {
  const words = [];
  let word = '',
    quote = null,
    started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"') word += text[++i];
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) words.push(word);
      word = '';
      started = false;
    } else if (c === '\\') {
      word += text[++i];
      started = true;
    } else {
      word += c;
      started = true;
    }
  }
  if (quote) friction('Unclosed quote in advertised command');
  if (started) words.push(word);
  const [executable, agent, root, action, ...args] = words;
  if (executable !== 'nforge' || agent !== 'agent' || !root || !action)
    friction('Unrecognized advertised agent command');
  const body = JSON.parse(args.at(-1));
  return { root: resolve(cwd, root), action, body, flags: args.slice(0, -1) };
}

export function continuation(value, root) {
  if (value.command) {
    const command = printedCommand(value.command, root);
    if (value.next) {
      for (const [key, expected] of Object.entries(value.next)) {
        const actual = key === 'action' ? command.action : command.body[key];
        if (JSON.stringify(actual) !== JSON.stringify(expected))
          friction(`Advertised next and command disagree on ${key}`);
      }
    }
    return command;
  }
  if (value.next?.action) {
    const { action, ...body } = value.next;
    return { root, action, body, flags: [] };
  }
  return null;
}

function sourceFailed(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.status === 'failed' || value.outcome?.status === 'failed') return true;
  return ['source', 'progress', 'terminal'].some(key => sourceFailed(value[key]));
}

/** Keep pending operations outside the landing budget. A resolved server outcome alone
 * never means local apply completed: only resolve's advertised finish advances that phase. */
export async function driveForge({
  root,
  laneId,
  message,
  call = callForge,
  edit = keepBoth,
  pause = () => wait(10_000),
  maxLandAttempts = 8,
}) {
  let command = { root, action: 'land', flags: ['--save'], body: { message } };
  let landAttempts = 0,
    newLanding = true,
    lastInterrupted = null;
  let activeLaneId = laneId;
  for (;;) {
    if (newLanding && ++landAttempts > maxLandAttempts) throw Error('BENCH_LAND_ATTEMPTS_EXHAUSTED');
    newLanding = false;
    const response = await call(command);
    const result = response.result ?? {};
    if (result.submission?.phase === 'landed' || result.phase === 'landed')
      return { root: command.root, landAttempts };
    const code = response.error?.code;
    if (['OVERLAP_UNANSWERED', 'PREFLIGHT_REQUIRED'].includes(code)) {
      await call({
        root: command.root,
        action: code === 'OVERLAP_UNANSWERED' ? 'ack' : 'preflight',
        body: {
          laneId: command.body.laneId ?? activeLaneId,
          ...(code === 'OVERLAP_UNANSWERED' ? { choice: 'accept-order' } : {}),
        },
        flags: [],
      });
      await pause();
      newLanding = ['land', 'finish'].includes(command.action);
      continue;
    }
    if (response.error) {
      // This is Forge's printed interrupted-action advice, not inferred success or a new
      // operation. A repeated obstruction is surfaced with its original response intact.
      const identity = JSON.stringify(command);
      if (
        /Retry the original hosted agent action and parameters/.test(response.error.message ?? '') &&
        command.body.operationId &&
        lastInterrupted !== identity
      ) {
        lastInterrupted = identity;
        await pause();
        continue;
      }
      friction(`Action ${command.action} failed: ${JSON.stringify(response.error)}`);
    }
    lastInterrupted = null;
    const recovery = result.recovery ?? result;
    if (sourceFailed(recovery)) friction(`Source failed: ${JSON.stringify(recovery)}`);
    const conflict = recovery.conflict;
    if (conflict?.root) {
      const next = continuation(conflict, conflict.root);
      if (next?.action !== 'resolve' || next.root !== resolve(conflict.root))
        friction('Conflict root has no unambiguous resolve continuation');
      await edit(conflict);
      activeLaneId = next.body.laneId ?? activeLaneId;
      command = next;
      continue;
    }
    const next = continuation(conflict ?? recovery, command.root);
    if (!next) friction(`Action ${command.action} returned no terminal result or continuation`);
    if (
      ['sync', 'resolve'].includes(command.action) &&
      next.action === command.action &&
      command.body.operationId &&
      next.body.operationId !== command.body.operationId
    )
      friction('Pending source continuation changed operation identity');
    if (command.action === 'resolve' && ['land', 'finish'].includes(next.action) && !result.applied)
      friction('Resolve advertised finish without a local apply result');
    newLanding = ['land', 'finish'].includes(next.action) && !['land', 'finish'].includes(command.action);
    // Keep the existing landing retry cadence; bounded sync/resolve waits drive source.
    if (['land', 'finish'].includes(next.action)) await pause();
    command = next;
  }
}

export function keepBoth(conflict) {
  const paths = new Set(conflict.paths ?? []);
  // Replies may abbreviate paths; the advertised editable root still contains every
  // materialized conflict. Inspect it like an agent, without repository/task exceptions.
  function inventory(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.isDirectory()) inventory(join(directory, entry.name), path);
      else if (entry.isFile()) paths.add(path);
    }
  }
  if (conflict.more || !conflict.paths) inventory(conflict.root);
  for (const path of paths) {
    const file = resolve(conflict.root, path);
    if (!file.startsWith(resolve(conflict.root) + '/')) friction('Conflict path escapes its root');
    const text = readFileSync(file, 'utf8');
    const kept = text
      .split('\n')
      .filter(line => !/^(<<<<<<< |=======$|>>>>>>> )/.test(line))
      .join('\n');
    if (kept !== text) writeFileSync(file, kept);
  }
}

const run = promisify(execFile);
export async function callForge(command) {
  let stdout = '',
    stderr = '';
  try {
    ({ stdout, stderr } = await run(
      'nforge',
      ['agent', command.root, command.action, ...(command.flags ?? []), JSON.stringify(command.body)],
      { cwd: command.root, maxBuffer: 64 << 20 },
    ));
  } catch (error) {
    stdout = String(error.stdout ?? '');
    stderr = String(error.stderr ?? '');
  }
  // Preserve every child body and error in the agent transcript, including nonzero exits.
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  const replies = [...stdout.split('\n'), ...stderr.split('\n')].flatMap(line => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const reply = replies.findLast(value => value && (value.error || value.result));
  if (!reply) friction('Agent command returned no structured reply');
  return reply;
}
