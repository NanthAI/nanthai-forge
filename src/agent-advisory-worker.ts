// SPDX-License-Identifier: Apache-2.0
import { isMainModule } from '../scripts/main-module.mjs';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { processAlive, processIdentity } from './local-process.js';
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

if (isMainModule(import.meta.url)) {
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
