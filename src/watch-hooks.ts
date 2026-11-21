// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { feedEventSchema, type ProjectFeedEvent } from './feed-client.js';
import { z } from 'zod';

const hookNames = ['event', 'landing'] as const;
type Hook = (typeof hookNames)[number];
export const undeliveredFeedEvent = z.object({
  event: feedEventSchema,
  hooks: z.array(z.enum(hookNames)),
});
type Pending = z.infer<typeof undeliveredFeedEvent>;
type Job = { event: ProjectFeedEvent; hook: Hook; attempt: number; at: number };

function runCommand(command: string, event: ProjectFeedEvent, signal: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn(command, {
      shell: true,
      stdio: ['pipe', process.stderr, process.stderr],
      env: { ...process.env, FORGE_EVENT_ID: event.id, FORGE_EVENT_KIND: event.kind },
      signal,
    });
    child.on('error', () => resolve(false));
    child.on('exit', code => resolve(code === 0));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(event) + '\n');
  });
}

/** Persist the pending hooks before running a user command. One failed command can
 * wait for local backoff while subsequent events and commands continue flowing. */
export function watchHooks(options: {
  commands: Partial<Record<Hook, string>>;
  pending: Pending[];
  signal: AbortSignal;
  retain: (pending: Pending) => void;
  complete: (eventId: string, hook: Hook) => void;
  warn: (event: ProjectFeedEvent, hook: Hook) => void;
  fail: (error: unknown) => void;
  run?: typeof runCommand;
  now?: () => number;
  delays?: number[];
}) {
  const { commands, signal } = options;
  const run = options.run ?? runCommand;
  const now = options.now ?? (() => performance.now());
  const delays = options.delays ?? [1_000, 5_000, 30_000];
  const pending = new Map(options.pending.map(item => [item.event.id, item]));
  const jobs = new Map<string, Job>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  let stopped = false;
  const schedule = () => {
    clearTimeout(timer);
    if (active || stopped || signal.aborted) return;
    let first: [string, Job] | undefined;
    for (const entry of jobs) if (!first || entry[1].at < first[1].at) first = entry;
    if (!first) return;
    const [key, job] = first;
    const wait = job.at - now();
    if (wait > 0) {
      timer = setTimeout(schedule, wait);
      return;
    }
    active = Promise.resolve()
      .then(() => run(commands[job.hook]!, job.event, signal))
      .catch(() => false)
      .then(ok => {
        if (signal.aborted || stopped) return;
        const delay = delays[job.attempt++];
        if (ok) {
          jobs.delete(key);
          const item = pending.get(job.event.id)!;
          item.hooks = item.hooks.filter(hook => hook !== job.hook);
          if (!item.hooks.length) pending.delete(job.event.id);
          options.complete(job.event.id, job.hook);
        } else if (delay !== undefined) {
          job.at = now() + delay;
        } else {
          jobs.delete(key);
          options.warn(job.event, job.hook);
        }
      })
      .catch(error => {
        stopped = true;
        options.fail(error);
      })
      .finally(() => {
        active = undefined;
        schedule();
      });
  };
  const queue = ({ event, hooks }: Pending) => {
    for (const hook of hooks) {
      const key = `${hook}:${event.id}`;
      if (commands[hook] && !jobs.has(key)) jobs.set(key, { event, hook, attempt: 0, at: now() });
    }
  };
  return {
    start() {
      for (const item of pending.values()) queue(item);
      schedule();
    },
    offer(event: ProjectFeedEvent) {
      const hooks = hookNames.filter(
        hook => commands[hook] && (hook === 'event' || event.kind.startsWith('landing.')),
      );
      if (!hooks.length || pending.has(event.id)) return;
      const item = { event, hooks };
      pending.set(event.id, item);
      options.retain(item);
      queue(item);
      schedule();
    },
    async close() {
      stopped = true;
      clearTimeout(timer);
      await active;
    },
  };
}
