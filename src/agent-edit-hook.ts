import { canonicalEditPath, editTarget } from './agent-edit-target.js';
import { mkdirBelow } from './mkdir-below.js';
import { Worker, MessageChannel, receiveMessageOnPort, isMainThread, workerData } from 'node:worker_threads';
import { recordEditDelivery } from './agent-edit-metrics.js';
import type { MetricObservation } from './self-metrics-observations.js';
import { childEnv } from '../scripts/child-env.mjs';
// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import { readFileSync, appendFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';

/** Small supervisor: enforces the one-second fail-open deadline even on blocked disk IO. */
export function runEditHook(
  owner: string,
  laneId: string,
  input: unknown,
  worker = fileURLToPath(import.meta.url),
) {
  if (worker === fileURLToPath(import.meta.url)) {
    const signal = new Int32Array(new SharedArrayBuffer(4));
    const { port1, port2 } = new MessageChannel();
    const thread = new Worker(new URL(import.meta.url), {
      workerData: { kind: 'forge-edit-hook', owner, laneId, input, signal, port: port2 },
      transferList: [port2],
      env: childEnv({ allow: ['FORGE_AUTH_TOKEN', 'XDG_CONFIG_HOME', 'FORGE_CLIENT_SETTINGS'] }),
      execArgv: [],
    });
    thread.on('error', () => {
      /* The bounded wait below records unavailable workers. */
    });
    thread.unref();
    const wait = Atomics.wait(signal, 0, 0, 1000);
    const message = receiveMessageOnPort(port1)?.message;
    port1.close();
    void thread.terminate();
    if (message?.kind === 'forge-edit-hook-result') {
      for (const delivery of message.deliveries ?? []) recordEditDelivery(delivery.directory, delivery.event);
      return message.output;
    }
    return failOpen(owner, laneId, wait === 'timed-out' ? 'timeout' : 'unreachable');
  }
  const child = spawnSync(process.execPath, [worker, '--worker', owner, laneId], {
    env: childEnv({ allow: ['FORGE_AUTH_TOKEN', 'XDG_CONFIG_HOME', 'FORGE_CLIENT_SETTINGS'] }),
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 1000,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024,
  });
  if (child.status === 0 && !child.error) {
    try {
      const result = JSON.parse(child.stdout);
      if (result.kind === 'forge-edit-hook-result') {
        for (const delivery of result.deliveries ?? [])
          recordEditDelivery(delivery.directory, delivery.event);
        return result.output;
      }
      return result;
    } catch {
      /* malformed response fails open below */
    }
  }
  return failOpen(
    owner,
    laneId,
    (child.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' ? 'timeout' : 'unreachable',
  );
}
function failOpen(owner: string, laneId: string, reason: string) {
  const event = {
    kind: 'edit-hook-fail-open',
    at: new Date().toISOString(),
    laneId,
    reason,
  };
  try {
    if (owner === '--auto') throw new Error('No native log');
    const directory = join(owner, '.forge', 'work', 'edit-hook');
    mkdirBelow(join(owner, '.forge', 'work'), directory);
    appendFileSync(join(directory, 'fail-open.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 });
  } catch {
    // Owner unavailable: the caller's stderr still records the failure.
  }
  process.stderr.write(JSON.stringify(event) + '\n');
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: 'Forge first-write coverage incomplete (timeout or unavailable); edit continued.',
    },
  };
}

const hookDeliveries: {
  directory: string;
  event: Extract<MetricObservation, { type: 'overlap-delivery' }>;
}[] = [];
async function worker(owner: string, laneId: string, input: Record<string, unknown>) {
  if (owner === '--auto') return autoWorker(input);
  owner = realpathSync(owner);
  const { preEdit } = await import('./agent-pre-edit.js');
  const { readAgentTurn, recordAgentTurn } = await import('./agent-edit-context.js');
  const agent = input.agent === 'codex' || input.turn_id ? ('codex' as const) : ('claude-code' as const);
  const sessionId = String(input.session_id ?? 'unknown');
  const directory = join(owner, '.forge', 'work');
  const previous = readAgentTurn(directory, laneId);
  if (input.hook_event_name === 'UserPromptSubmit') {
    const lane = join(directory, `lane-${laneId}`);
    if (
      typeof input.cwd === 'string' &&
      canonicalEditPath(input.cwd) !== lane &&
      !canonicalEditPath(input.cwd).startsWith(lane + sep)
    )
      return {};
    recordAgentTurn(directory, laneId, { agent, sessionId, turnId: String(input.turn_id ?? randomUUID()) });
    return {};
  }
  const conversation = {
    agent,
    sessionId,
    turnId: String(
      input.turn_id ??
        (previous?.sessionId === sessionId ? previous.turnId : (input.tool_use_id ?? randomUUID())),
    ),
  };
  const tool = input.tool_input as Record<string, unknown> | undefined;
  const cwd = typeof input.cwd === 'string' ? input.cwd : join(directory, `lane-${laneId}`);
  const lane = join(directory, `lane-${laneId}`);
  const raw = [
    tool?.file_path,
    tool?.notebook_path,
    ...(Array.isArray(input.paths) ? input.paths : []),
  ].filter((value): value is string => typeof value === 'string');
  if (Array.isArray(tool?.edits))
    for (const edit of tool.edits) if (typeof edit?.file_path === 'string') raw.push(edit.file_path);
  if (input.tool_name === 'apply_patch' && typeof tool?.command === 'string') {
    for (const match of tool.command.matchAll(
      /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm,
    ))
      raw.push(match[1]!);
  }
  const paths = raw
    .map(path =>
      relative(lane, canonicalEditPath(resolve(cwd, path)))
        .split(sep)
        .join('/'),
    )
    .filter(path => path && path !== '..' && !path.startsWith('../') && !isAbsolute(path));
  if (!paths.length) return {};
  const result = preEdit(owner, laneId, paths, conversation, event =>
    hookDeliveries.push({ directory, event }),
  );
  if (result.status === 'overlap')
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext:
          `Forge first-write: ${result.count} overlap(s), coverage=${result.coverage}. ` +
          result.overlaps.map(item => `${item.file.slice(0, 160)} (${item.noticeId})`).join('\n'),
      },
    };
  // Hash is an opaque local conversation reference, never transcript content.
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: `Forge first-write check: ${result.status} (${result.coverage}); session ${sessionId}, turn ${conversation.turnId}; reference ${createHash('sha256').update(JSON.stringify(conversation)).digest('hex')}.`,
    },
  };
}
async function autoWorker(input: Record<string, unknown>) {
  const { editHooksEnabled } = await import('./agent-hook-settings.js');
  if (!editHooksEnabled()) return {};
  const { preEditHosted, hostedEditContext } = await import('./agent-edit-hosted.js');
  const tool = input.tool_input as Record<string, unknown> | undefined;
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const raw = [
    tool?.file_path,
    tool?.notebook_path,
    ...(Array.isArray(input.paths) ? input.paths : []),
  ].filter((path): path is string => typeof path === 'string');
  if (Array.isArray(tool?.edits))
    for (const edit of tool.edits) if (typeof edit?.file_path === 'string') raw.push(edit.file_path);
  if (input.tool_name === 'apply_patch') {
    const patch = tool?.command ?? tool?.patch ?? input.tool_input;
    if (typeof patch === 'string')
      for (const match of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm))
        raw.push(match[1]!);
  }
  // Prompt attribution for native Lanes still uses the established local turn store.
  if (input.hook_event_name === 'UserPromptSubmit') raw.push(join(cwd, '.forge-hook-target'));
  const contexts: string[] = [];
  const seen = new Set<string>();
  for (const path of raw) {
    const target = editTarget(resolve(cwd, path));
    if (!target || !editHooksEnabled(target.project)) continue;
    const key = JSON.stringify([target.root, target.path]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (target.url) {
      if (input.hook_event_name === 'UserPromptSubmit') continue;
      const result = await preEditHosted(
        target,
        String(input.session_id ?? input.tool_use_id ?? randomUUID()),
      );
      const context = hostedEditContext(result);
      if (context) contexts.push(context);
    } else {
      const result = await worker(target.root, target.laneId, { ...input, paths: [path] });
      if (result.hookSpecificOutput?.additionalContext)
        contexts.push(result.hookSpecificOutput.additionalContext);
    }
  }
  return contexts.length
    ? {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: contexts.join('\n').slice(0, 1800),
        },
      }
    : {};
}
if (!isMainThread && workerData?.kind === 'forge-edit-hook') {
  try {
    const output = await worker(workerData.owner, workerData.laneId, workerData.input);
    workerData.port.postMessage({ kind: 'forge-edit-hook-result', output, deliveries: hookDeliveries });
  } catch {
    workerData.port.postMessage({ failed: true });
  } finally {
    Atomics.store(workerData.signal, 0, 1);
    Atomics.notify(workerData.signal, 0);
    workerData.port.close();
  }
} else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const child = process.argv[2] === '--worker';
  const owner = process.argv[child ? 3 : 2]!,
    laneId = process.argv[child ? 4 : 3]!;
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const result = child ? await worker(owner, laneId, input) : runEditHook(owner, laneId, input);
    process.stdout.write(
      JSON.stringify(
        child ? { kind: 'forge-edit-hook-result', output: result, deliveries: hookDeliveries } : result,
      ) + '\n',
    );
  } catch {
    if (child) process.exitCode = 1;
    else {
      process.stdout.write(JSON.stringify(failOpen(owner, laneId, 'input')) + '\n');
    }
  }
}
