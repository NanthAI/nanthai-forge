// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getFunctionName, makeFunctionReference } from 'convex/server';
import { coordinationClient } from '../dist/coordination-client.js';
import { ConvexExchange } from '../dist/exchange-client.js';
import { hostedRunSubscription } from '../dist/hosted-agent-observe.js';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';
import { dogfoodProject, drillDeployment } from './phase5-hosted-lifecycle-drill.mjs';

export const decode = value => (typeof value === 'string' ? JSON.parse(value) : value);
export const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
export const writeJson = (path, value) =>
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
export function createActionsDrillContext(directory, cleanup = false) {
  const reportPath = join(directory, 'report.json');
  const report = readJson(reportPath);
  const projectId = report.project.projectId;
  assert.notEqual(projectId, dogfoodProject);
  assert.equal(report.authority.authority.mode, 'server');
  const address = { url: drillDeployment, projectId };
  const log = join(directory, 'actions-calls.jsonl');
  const entries = () =>
    existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const record = (kind, name) => {
    const deliveryLog = join(directory, 'delivery-calls.jsonl');
    const deliveryCalls = existsSync(deliveryLog)
      ? readFileSync(deliveryLog, 'utf8').trim().split('\n').filter(Boolean).length
      : 0;
    const count = report.calls.length + entries().length + deliveryCalls + 100;
    // The 700-call server allowance is an estimate, never a billed-call claim.
    // Reserve 100 more for initial uninstrumented CLI bootstrap/preflight work.
    const cleanupReserve = cleanup ? 0 : (report.budget?.cleanupReserve ?? 180);
    assert(count + 700 + cleanupReserve < 2000, 'Q4 stop budget; retain cleanup reserve');
    appendFileSync(log, JSON.stringify({ kind, name, at: new Date().toISOString() }) + '\n', {
      mode: 0o600,
    });
  };
  const base = coordinationClient(drillDeployment);
  const client = Object.fromEntries(
    ['query', 'mutation', 'action'].map(kind => [
      kind,
      async (reference, args) => {
        assert(args.projectId === undefined || args.projectId === projectId);
        record(kind, getFunctionName(reference));
        return base[kind](reference, args);
      },
    ]),
  );
  const exchange = (operationId = randomUUID()) => {
    const result = new ConvexExchange(drillDeployment, undefined, projectId, operationId, null);
    result.client = client;
    return result;
  };
  const query = async (name, args = {}) =>
    decode(await client.query(makeFunctionReference(name), { projectId, ...args }));
  const mutation = async (name, args = {}) =>
    decode(await client.mutation(makeFunctionReference(name), { projectId, ...args }));
  const subscribe = () => {
    const live = hostedRunSubscription(address);
    return {
      onUpdate(reference, args, update, error) {
        record('subscription', getFunctionName(reference));
        return live.onUpdate(
          reference,
          args,
          value => {
            try {
              record('reactive-update', getFunctionName(reference));
              update(value);
            } catch (failure) {
              error(failure);
            }
          },
          error,
        );
      },
      close: () => live.close(),
    };
  };
  const waitSelected = async (name, args, done, timeoutMs = 600_000) => {
    const live = subscribe();
    let close;
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Object.assign(Error('Selected drill wait expired'), {
                code: 'DRILL_INCOMPLETE',
              }),
            ),
          timeoutMs,
        );
        close = live.onUpdate(
          makeFunctionReference(name),
          { projectId, ...args },
          value => {
            try {
              const parsed = decode(value);
              if (done(parsed)) resolve(parsed);
            } catch (failure) {
              reject(failure);
            }
          },
          reject,
        );
      });
    } finally {
      clearTimeout(timer);
      close?.();
      await live.close();
    }
  };
  const agent = root => new HostedAgentTransport(root, address, exchange(), subscribe);
  const save = () => writeJson(reportPath, report);
  const step = async (name, run) => {
    const start = performance.now();
    try {
      const result = await run();
      report.steps.push({ name, status: 'passed', wallMs: Math.round(performance.now() - start) });
      save();
      console.log(JSON.stringify({ step: name, status: 'passed' }));
      return result;
    } catch (failure) {
      report.steps.push({
        name,
        status: 'failed',
        code: failure.data?.code ?? failure.code ?? 'DRILL_FAILED',
      });
      save();
      throw failure;
    }
  };
  return {
    directory,
    report,
    save,
    client,
    address,
    exchange,
    query,
    mutation,
    subscribe,
    waitSelected,
    agent,
    step,
    entries,
  };
}

/** A virtual client-only interruption. No server clock or actual network is changed. */
export async function virtualClientInterruption(offlineMs, calls, attempt) {
  assert([0, 600_000, 1_800_000].includes(offlineMs));
  let now = 0;
  const before = calls();
  const offline = async () => {
    throw Object.assign(Error('Synthetic disconnected client'), { code: 'Q4_CLIENT_OFFLINE' });
  };
  if (offlineMs) {
    await assert.rejects(attempt(offline), { code: 'Q4_CLIENT_OFFLINE' });
    now += offlineMs;
  }
  assert.equal(calls(), before, 'offline client must make zero live calls');
  return { syntheticClientClock: true, offlineMs: now, physicalOutage: false, liveCallsWhileOffline: 0 };
}

export async function saveActionsDrillLane(context, root, request) {
  const saved = await context.agent(root).dispatch('save', request);
  const progress = await context.waitSelected(
    'projectHostedSaves:progress',
    {
      operationId: saved.operationId,
    },
    value => !!value.terminal,
  );
  assert.equal(progress.terminal.outcome.status, 'completed');
  // Observation proves server completion; original-operation replay separately
  // acknowledges that head in this editing root before finish captures it.
  return context.agent(root).dispatch('save', request);
}
