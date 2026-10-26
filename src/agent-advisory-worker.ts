// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processAlive, processIdentity } from './local-process.js';
import { childEnv } from '../scripts/child-env.mjs';
import { ownerEnvNames } from './worker-environment.js';
import { withQueueSlot } from './landing-queue.js';
import { mkdirBelow } from './mkdir-below.js';
import { writeRecoveryState } from './recovery-state.js';
import { WorkStore } from './work-store.js';
import { agentResponseAdvisory } from './agent-response-advisory.js';
import type { AgentAction } from './agent-workflow-schema.js';

type Command = Extract<AgentAction, { action: 'start' | 'checkpoint' }>;
type Response = { revision: number; result: unknown };
const children = new Map<string, Set<Promise<void>>>();
const references = new Map<Promise<void>, ReturnType<typeof spawn>>();

/** Owner shutdown and synthetic-owner teardown join finite observations. */
export async function drainAgentAdvisories(root: string) {
  const store = new WorkStore(root);
  root = store.root;
  while (children.get(root)?.size) {
    const pending = [...children.get(root)!];
    for (const done of pending) references.get(done)?.ref();
    await Promise.all(pending);
  }
  const pending = join(store.directory, 'agent-advisory', 'pending');
  while (existsSync(pending)) {
    let running = false;
    for (const name of readdirSync(pending)) {
      if (!/^[a-f0-9-]+$/.test(name)) continue;
      const directory = join(pending, name);
      try {
        const ticket = JSON.parse(readFileSync(join(directory, 'ticket.json'), 'utf8')) as {
          worker?: { pid: number; startTime?: string };
        };
        if (!ticket.worker || processAlive(ticket.worker)) running = true;
        else rmSync(directory, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (!running) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

export const agentAdvisoryTestHooks: { launch?: typeof spawn } = {};

/** Finite, detached observation. No promise, pipe, timer or worker handle can
 * retain the requesting CLI. Embedders can skip this optional refresh. */
export function scheduleAgentAdvisory(
  store: WorkStore,
  command: Command,
  response: Response,
  liveMcp = false,
) {
  if (!liveMcp && !process.argv[1]?.endsWith('/cli.js') && !agentAdvisoryTestHooks.launch) return;
  const directory = join(store.directory, 'agent-advisory');
  if (existsSync(join(directory, `${command.operationId}.json`))) return;
  const pending = join(directory, 'pending', command.operationId!);
  const tracked = !agentAdvisoryTestHooks.launch;
  if (tracked && existsSync(join(pending, 'ticket.json'))) return;
  try {
    // Publish a pending ticket before process startup: a quiet-owner snapshot
    // must not mistake a slow-starting worker for completed background work.
    if (tracked) {
      mkdirBelow(store.directory, pending);
      writeRecoveryState(join(pending, 'ticket.json'), { operationId: command.operationId });
    }
    const child = (agentAdvisoryTestHooks.launch ?? spawn)(
      process.execPath,
      [fileURLToPath(import.meta.url), store.root, JSON.stringify({ command, response, liveMcp })],
      {
        detached: true,
        stdio: 'ignore',
        env: childEnv({ allow: [...ownerEnvNames, 'FORGE_AUTH_TOKEN'] }),
      },
    );
    child.on('error', () => {
      /* Refresh failures never reject the saved operation. */
    });
    if (tracked) {
      writeRecoveryState(join(pending, 'ticket.json'), {
        operationId: command.operationId,
        worker: { pid: child.pid! },
      });
      const active = children.get(store.root) ?? new Set<Promise<void>>();
      children.set(store.root, active);
      let complete: () => void;
      const done = new Promise<void>(resolve => {
        complete = resolve;
      });
      active.add(done);
      references.set(done, child);
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        rmSync(pending, { recursive: true, force: true });
        active.delete(done);
        references.delete(done);
        if (!active.size) children.delete(store.root);
        complete();
      };
      child.once('close', finish);
      child.once('error', finish);
    }
    child.unref();
  } catch {
    if (tracked) rmSync(pending, { recursive: true, force: true });
    // Receipt replay remains independent of unavailable advisory workers.
  }
}

export async function refreshAgentAdvisory(
  store: WorkStore,
  command: Command,
  response: Response,
  liveMcp = false,
) {
  const directory = join(store.directory, 'agent-advisory');
  mkdirBelow(store.directory, directory);
  const done = join(directory, `${command.operationId}.json`);
  return withQueueSlot(
    join(directory, 'drain'),
    async () => {
      if (existsSync(done)) return;
      await agentResponseAdvisory(store, command, response, undefined, [], liveMcp, false);
      writeRecoveryState(done, { operationId: command.operationId, revision: response.revision });
    },
    { anchor: store.directory, phase: 'agent advisory refresh' },
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let pending: string | undefined;
  try {
    const { command, response, liveMcp } = JSON.parse(process.argv[3]!) as {
      command: Command;
      response: Response;
      liveMcp: boolean;
    };
    const store = new WorkStore(process.argv[2]!);
    pending = join(store.directory, 'agent-advisory', 'pending', command.operationId!);
    if (existsSync(pending))
      writeRecoveryState(join(pending, 'ticket.json'), {
        operationId: command.operationId,
        worker: processIdentity(),
      });
    await refreshAgentAdvisory(store, command, response, liveMcp);
  } catch {
    // A later explicit peers/link read can rebuild unavailable derived data.
  } finally {
    if (pending) rmSync(pending, { recursive: true, force: true });
  }
}
