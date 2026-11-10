// SPDX-License-Identifier: Apache-2.0
import { isMainModule } from '../scripts/main-module.mjs';
import { cliPackageRoot, retainCliRuntime } from './cli-installation.js';
import { editTarget } from './agent-edit-target.js';
import { Worker, MessageChannel, receiveMessageOnPort, isMainThread, workerData } from 'node:worker_threads';
import { childEnv } from '../scripts/child-env.mjs';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

/** XDG_STATE_HOME: the board feature marker lives there (written by Lane actions); without it a
 * hook under a custom state directory would read the wrong marker and send no board argument. */
const hookEnvNames = ['FORGE_AUTH_TOKEN', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'FORGE_CLIENT_SETTINGS'];
let runtimeAvailable = true;
if (isMainThread) {
  try {
    retainCliRuntime(cliPackageRoot(import.meta.url));
  } catch {
    runtimeAvailable = false;
  }
}

/** Small supervisor: enforces the one-second fail-open deadline even on blocked disk IO. */
export function runEditHook(
  owner: string,
  laneId: string,
  input: unknown,
  worker = fileURLToPath(import.meta.url),
) {
  if (!runtimeAvailable) return failOpen(laneId, 'unreachable');
  if (worker === fileURLToPath(import.meta.url)) {
    const signal = new Int32Array(new SharedArrayBuffer(4));
    const { port1, port2 } = new MessageChannel();
    const thread = new Worker(new URL(import.meta.url), {
      workerData: { kind: 'forge-edit-hook', owner, laneId, input, signal, port: port2 },
      transferList: [port2],
      env: childEnv({ allow: hookEnvNames }),
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
    if (message?.kind === 'forge-edit-hook-result') return message.output;
    return failOpen(laneId, wait === 'timed-out' ? 'timeout' : 'unreachable');
  }
  const child = spawnSync(process.execPath, [worker, '--worker', owner, laneId], {
    env: childEnv({ allow: hookEnvNames }),
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 1000,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024,
  });
  if (child.status === 0 && !child.error) {
    try {
      const result = JSON.parse(child.stdout);
      if (result.kind === 'forge-edit-hook-result') return result.output;
      return result;
    } catch {
      /* malformed response fails open below */
    }
  }
  return failOpen(
    laneId,
    (child.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' ? 'timeout' : 'unreachable',
  );
}
function failOpen(laneId: string, reason: string) {
  const event = {
    kind: 'edit-hook-fail-open',
    at: new Date().toISOString(),
    laneId,
    reason,
  };
  process.stderr.write(JSON.stringify(event) + '\n');
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: 'Forge first-write coverage incomplete (timeout or unavailable); edit continued.',
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
  const contexts: string[] = [];
  const seen = new Set<string>();
  for (const path of raw) {
    const target = editTarget(resolve(cwd, path));
    if (!target || !editHooksEnabled(target.project)) continue;
    const key = JSON.stringify([target.root, target.path]);
    if (seen.has(key)) continue;
    seen.add(key);
    const session = String(input.session_id ?? input.tool_use_id ?? randomUUID());
    const context = hostedEditContext(await preEditHosted(target, session));
    if (context) contexts.push(context);
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
    const output = await autoWorker(workerData.input);
    workerData.port.postMessage({ kind: 'forge-edit-hook-result', output });
  } catch {
    workerData.port.postMessage({ failed: true });
  } finally {
    Atomics.store(workerData.signal, 0, 1);
    Atomics.notify(workerData.signal, 0);
    workerData.port.close();
  }
} else if (isMainModule(import.meta.url)) {
  const child = process.argv[2] === '--worker';
  const owner = process.argv[child ? 3 : 2]!,
    laneId = process.argv[child ? 4 : 3]!;
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const result = child ? await autoWorker(input) : runEditHook(owner, laneId, input);
    process.stdout.write(
      JSON.stringify(child ? { kind: 'forge-edit-hook-result', output: result } : result) + '\n',
    );
  } catch {
    if (child) process.exitCode = 1;
    else process.stdout.write(JSON.stringify(failOpen(laneId, 'input')) + '\n');
  }
}
