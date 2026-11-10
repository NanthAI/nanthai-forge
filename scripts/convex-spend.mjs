// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { childEnv } from './child-env.mjs';
import { isMainModule } from './main-module.mjs';
import { spendEvent, pendingAlerts, utcDay, spendRates } from './convex-spend-model.mjs';
import { driftAlerts } from './convex-spend-drift.mjs';
import { spendPlan, planAlerts } from './convex-spend-plan.mjs';
import { SpendJournal, journalLock, privateConfig } from './convex-spend-journal.mjs';

export async function notifySpend(hook, alert) {
  if (!hook) return;
  if (
    !Array.isArray(hook.command) ||
    !hook.command.length ||
    !hook.command.every(s => typeof s === 'string') ||
    typeof hook.topic !== 'string' ||
    typeof hook.target !== 'string'
  )
    throw Error('SPEND_HOOK_CONFIG');
  await new Promise((resolveHook, reject) => {
    const child = spawn(hook.command[0], hook.command.slice(1), {
      env: childEnv(),
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Error('SPEND_HOOK_TIMEOUT'));
    }, 30_000);
    child.on('error', () => {
      clearTimeout(timer);
      reject(Error('SPEND_HOOK_FAILED'));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolveHook();
      else reject(Error('SPEND_HOOK_FAILED'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ topic: hook.topic, target: hook.target, ...alert }) + '\n');
  });
}

export async function printSpend(journal, now = Date.now(), plan = null, deployments = []) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const day = utcDay(now - i * 86_400_000);
    days.push(await journal.report(day, now));
    journal.days.delete(day);
  }
  console.log(
    JSON.stringify(
      {
        ...(plan ? { billing: await journal.billing(plan, now, deployments) } : {}),
        landingDrift: await journal.drift(now, deployments),
        rates: spendRates,
        units: { calls: 'calls', io: 'bytes', search: 'query-bytes', compute: 'GB-hours', egress: 'bytes' },
        today: days[0],
        yesterday: days[1],
        trend: days.map(({ day, usd, knownUsd, usage, deployments, gaps }) => ({
          day,
          usd,
          knownUsd,
          usage,
          coverageMs: deployments.map(d => ({ deployment: d.deployment, ms: d.coveredMs })),
          gaps: gaps.length,
        })),
        top10: days[0].perFunction.slice(0, 10),
      },
      null,
      2,
    ),
  );
}

export async function runSpend(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      state: { type: 'string' },
      deployment: { type: 'string', multiple: true },
      stdin: { type: 'boolean' },
      print: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'Usage: node scripts/convex-spend.mjs --state PRIVATE_DIRECTORY [--config PRIVATE_JSON] [--deployment NAME ...] [--stdin | --print]',
    );
    return;
  }
  const config = privateConfig(values.config);
  const plan = spendPlan(config.plan);
  const state = values.state ?? config.stateDirectory;
  if (typeof state !== 'string' || !state) throw Error('SPEND_STATE_REQUIRED');
  const journal = new SpendJournal(resolve(state));
  if (values.print) {
    await printSpend(journal, Date.now(), plan, values.deployment ?? config.deployments ?? []);
    return;
  }
  const selected = values.deployment ?? config.deployments ?? ['dev'];
  if (!Array.isArray(selected)) throw Error('SPEND_DEPLOYMENTS_REQUIRED');
  const deployments = [...new Set(selected)];
  if (!deployments.length || !deployments.every(name => typeof name === 'string' && name.length))
    throw Error('SPEND_DEPLOYMENTS_REQUIRED');
  if (values.stdin && deployments.length !== 1) throw Error('SPEND_STDIN_ONE_DEPLOYMENT');
  const unlock = journalLock(resolve(state));
  const children = [],
    readers = [],
    covered = new Map();
  let queue = Promise.resolve(),
    failed = false,
    stopping = false;
  const enqueue = fn => {
    queue = queue.then(fn).catch(() => {
      failed = true;
      console.error('SPEND_LOCAL_ERROR (no raw logs retained)');
      stop();
    });
    return queue;
  };
  const tick = async (at = Date.now()) => {
    for (const [deployment, from] of covered) {
      await journal.coverage(deployment, from, at);
      covered.set(deployment, at);
    }
    const report = await journal.report(utcDay(at), at);
    if (plan) report.billing = await journal.billing(plan, at, deployments);
    report.landingDrift = await journal.drift(at, deployments);
    const alerts = [
      ...(plan ? planAlerts(report.billing) : pendingAlerts(report)),
      ...driftAlerts(report.landingDrift),
    ];
    for (const alert of alerts) {
      console.log(JSON.stringify({ ...alert, coverage: alert.coverage ?? report.coverage }));
      try {
        await notifySpend(config.notifier, alert);
        await journal.append({ kind: 'alert', key: alert.key, at });
        report.alerts.push(alert.key);
        if (plan) report.billing.alerts.push(alert.key);
      } catch {
        console.error('SPEND_HOOK_FAILED (will retry; hook must deduplicate alert.key)');
      }
    }
    journal.writeSummary(report);
  };
  function stop() {
    stopping = true;
    for (const child of children) child.kill('SIGTERM');
    if (values.stdin) process.stdin.destroy();
  }
  const onSignal = () => stop();
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  const timer = setInterval(() => enqueue(() => tick()), 30_000);
  try {
    for (const deployment of deployments) {
      await journal.gap(deployment, 'stream-start: earlier time and restart interval unobserved');
      let input;
      if (values.stdin) {
        input = process.stdin;
        covered.set(deployment, Date.now());
      } else {
        const child = spawn(
          process.execPath,
          [
            resolve('node_modules/convex/bin/main.js'),
            'logs',
            '--deployment',
            deployment,
            '--history',
            '0',
            '--jsonl',
            '--success',
          ],
          {
            env: childEnv({
              allow: [
                'CONVEX_DEPLOY_KEY',
                'CONVEX_DEPLOYMENT',
                'CONVEX_SELF_HOSTED_URL',
                'CONVEX_SELF_HOSTED_ADMIN_KEY',
              ],
            }),
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        children.push(child);
        input = child.stdout;
        let watching = false;
        readers.push(
          new Promise(done => {
            child.once('close', code => {
              if (!stopping || code) enqueue(() => journal.gap(deployment, 'stream-closed'));
              enqueue(async () => {
                const at = Date.now();
                if (covered.has(deployment)) await journal.coverage(deployment, covered.get(deployment), at);
                covered.delete(deployment);
              });
              if (!stopping) {
                failed = true;
                stop();
              }
              done();
            });
            child.once('error', () => {
              failed = true;
              enqueue(() => journal.gap(deployment, 'stream-error'));
              stop();
            });
          }),
        );
        const stderr = createInterface({ input: child.stderr });
        stderr.on('line', line =>
          enqueue(async () => {
            if (/^Watching logs/.test(line)) {
              watching = true;
              covered.set(deployment, Date.now());
            } else if (line.trim()) {
              await journal.gap(deployment, 'provider-warning: possible dropped events or transport gap');
              if (watching) covered.set(deployment, Date.now());
            }
          }),
        );
      }
      readers.push(
        (async () => {
          for await (const line of createInterface({ input, crlfDelay: Infinity }))
            await enqueue(async () => {
              if (!line.trim()) return;
              try {
                const event = spendEvent(JSON.parse(line), deployment);
                if (event) await journal.append(event, event.day);
              } catch {
                await journal.gap(deployment, 'invalid-or-unknown-provider-record');
              }
            });
        })(),
      );
    }
    await Promise.all(readers);
    await enqueue(async () => {
      await tick();
      for (const deployment of deployments)
        await journal.gap(deployment, 'stream-stopped: later time unobserved');
    });
    await queue;
  } finally {
    clearInterval(timer);
    stop();
    await Promise.allSettled(readers);
    await queue;
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    unlock();
  }
  if (failed) throw Error('SPEND_STREAM_FAILED');
}
if (isMainModule(import.meta.url))
  runSpend().catch(error => {
    console.error(/^SPEND_[A-Z_]+$/.test(error.message) ? error.message : 'SPEND_FAILED');
    process.exitCode = 1;
  });
