// SPDX-License-Identifier: Apache-2.0
// Real protocol adapters. Dependency injection permits offline incident tests, not simulated live acceptance.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { driveForge, callForge } from './forge-protocol.mjs';
import { replayExpected } from './replay-schedule.mjs';
import { resolveContributions, gitSource } from './replay-source.mjs';
import { landReplayGithub } from './replay-github.mjs';
import { taskIdentity } from './task-identity.mjs';
import { landingFields } from './score.mjs';
const exec = promisify(execFile);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
};

export function replayAdapters({
  plan,
  arm,
  forge,
  github,
  ws,
  bin,
  base,
  forgeBase,
  records,
  lanes,
  env = {},
  event = () => {},
  run = async (root, args) =>
    (await exec('git', ['-C', root, ...args], { env: { ...process.env, ...env }, maxBuffer: 64 << 20 }))
      .stdout,
  forgeCall = (command, taskEnv) =>
    callForge(command, { executable: join(bin, 'nforge'), env: { ...process.env, ...env, ...taskEnv } }),
  sleep = ms => pause(ms),
  now = Date.now,
}) {
  const expected = replayExpected(plan),
    first = deferred(),
    recovered = deferred(),
    second = deferred();
  const allGates = [first, recovered, second];
  const fail = error => allGates.forEach(g => g.reject(error));
  const repeated = plan.release === 'late-third' && !plan.independent;
  const sourceHead = root =>
    JSON.parse(readFileSync(join(root, '.forge/hosted-lane.json'), 'utf8')).selection.base.head;
  let pinned = null;
  const adapter = {
    async prepare(task) {
      const root = join(ws, task.id),
        branch = `agent-replay/${task.id}`,
        prep = {},
        started = now();
      const identity = { ...env, ...taskIdentity() };
      const record = { task: task.id, branch: arm === 'github' ? branch : null, prep };
      records.push(record);
      let laneId;
      if (arm === 'forge') {
        laneId = await forge.startLane(root, `synthetic replay ${task.id}`, prep, task.id, identity);
        record.laneId = laneId;
        lanes.set(laneId, { task: task.id, root });
      } else Object.assign(prep, await github.workspace(join(ws, 'hub'), root, branch));
      const head = arm === 'forge' ? sourceHead(root) : (await run(root, ['rev-parse', 'HEAD'])).trim();
      if (head !== (arm === 'forge' ? forgeBase : base) || (pinned && head !== pinned))
        throw Error('Diagnostic divergence: preparation base moved');
      pinned = head;
      record.prepSeconds = (now() - started) / 1000;
      const taskEnv = arm === 'forge' ? await forge.agentEnv(root, task.id, identity) : {};
      return { root, branch, laneId, record, env: { ...identity, ...taskEnv } };
    },
    async stage(task, ctx) {
      for (const edit of task.edits) {
        const file = join(ctx.root, edit.path);
        if (existsSync(file)) throw Error('Diagnostic divergence: fixture path exists in base');
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, edit.text);
      }
    },
    async land(task, ctx) {
      const { root, record } = ctx;
      const start = now();
      const operations = new Map();
      record.protocolCommands = [];
      record.dispatchedAt = new Date(start).toISOString();
      let recoveries = 0;
      // Fixed semantic receipt gates reproduce a late writer losing twice. They issue no reads.
      const gate = async (name, promise) => {
        event({ event: 'replay-gate', task: task.id, name });
        await promise;
      };
      try {
        if (repeated && task.id === 's10') await gate('first-peer-accepted', first.promise);
        if (repeated && task.id === 's09') await gate('tail-first-conflict-materialized', recovered.promise);
        if (arm === 'forge') {
          const result = await driveForge({
            pause: () => sleep(10_000),
            root,
            laneId: ctx.laneId,
            message: `synthetic replay ${task.id}`,
            call: async command => {
              if (
                repeated &&
                task.id === 's10' &&
                recoveries === 1 &&
                ['land', 'finish'].includes(command.action)
              )
                await gate('second-peer-accepted', second.promise);
              const at = now();
              // callForge uses the registered relay client; no model/sandbox agent is launched.
              if (!['wait', 'status', 'observe', 'queue'].includes(command.action))
                command.body.operationId ??= randomUUID();
              let response;
              try {
                response = await forgeCall(command, ctx.env);
              } catch (error) {
                if (
                  !/Agent command returned no structured reply|ECONNRESET|ETIMEDOUT|socket hang up/.test(
                    error.message,
                  )
                )
                  throw error;
                event({
                  event: 'replay-unknown-outcome',
                  task: task.id,
                  action: command.action,
                  operationId: command.body.operationId,
                });
                response = await forgeCall(command, ctx.env);
              }
              const commandTiming = {
                startedAt: new Date(at).toISOString(),
                replyReceivedAt: new Date(now()).toISOString(),
              };
              record.protocolCommands.push({
                action: command.action,
                operationId: command.body.operationId,
                ...commandTiming,
              });
              const submissions = [
                response.result?.submission,
                ...(response.result?.submissions ?? []).map(e => e.submission),
              ].filter(Boolean);
              for (const s of submissions) {
                const operationId =
                  s.operationId ??
                  (['land', 'finish'].includes(command.action) ? command.body.operationId : null);
                if (operationId)
                  operations.set(operationId, {
                    operationId,
                    phase: s.phase,
                    timing: s.timing ?? {},
                    commandTiming,
                  });
              }
              event({
                event: 'replay-command',
                task: task.id,
                action: command.action,
                ...commandTiming,
                response,
              });
              return response;
            },
            edit: async conflict => {
              if (conflict.more || !conflict.paths?.length)
                throw Error('Diagnostic divergence: incomplete conflict paths');
              resolveContributions(conflict.root, conflict.paths, expected);
              recoveries++;
              event({ event: 'replay-recovery', task: task.id, cycle: recoveries });
              if (task.id === 's10' && recoveries === 1) recovered.resolve();
            },
          });
          const s = result.submission;
          if (!s?.acceptance?.receiptId || !s.acceptance.head)
            throw Error('Diagnostic divergence: acceptance has no source receipt');
          record.landing = {
            landed: true,
            receiptId: s.acceptance.receiptId,
            mainHead: s.acceptance.head,
            acceptedAt: s.timing?.committedAt ?? s.acceptance.acceptedBy?.at,
            operations: [...operations.values()],
          };
        } else {
          const landed = await landReplayGithub({
            task,
            ctx,
            github,
            run,
            expected,
            repeated,
            gate,
            recovered,
            second,
            sleep,
            now,
            event,
          });
          record.landing = landed.landing;
          recoveries = landed.recoveries;
        }
        record.recoveries = recoveries;
        record.agent = { provider: 'scripted', elapsedSeconds: (now() - start) / 1000, usage: {} };
        Object.assign(record, landingFields(record.landing, start));
        if (task.id === 's08') first.resolve();
        if (task.id === 's09') second.resolve();
        if (repeated && task.id === 's10' && recoveries !== 2)
          throw Error(`Diagnostic divergence: tail recovered ${recoveries} times, expected two`);
        return record.landing;
      } catch (error) {
        record.harnessError = error.message;
        record.landing ??= { landed: false, state: 'diagnostic-divergence' };
        fail(error);
        throw error;
      }
    },
    async readMain(paths) {
      if (arm === 'github') {
        const root = join(ws, 'hub');
        await run(root, ['fetch', '-q', 'origin']);
        const head = (await run(root, ['rev-parse', 'origin/main'])).trim();
        return gitSource(root, head, paths);
      }
      const root = join(ws, 'final-main'),
        laneId = await forge.startLane(root, 'synthetic final oracle');
      lanes.set(laneId, { task: null, root });
      const head = sourceHead(root),
        files = new Map(
          paths.map(path => [
            path,
            existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null,
          ]),
        );
      await forge.abandon(root, laneId);
      await forge.removeRoot(root);
      lanes.delete(laneId);
      return { head, files };
    },
  };
  return adapter;
}
