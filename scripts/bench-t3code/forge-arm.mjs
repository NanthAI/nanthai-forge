// B1.5d Forge arm: hosted project imported from t3code@C (B1.5c), Lanes per task,
// `land --save` with the project's `verify` check (`bash .bench/ci.sh`) on GitHub Actions.
// QUALIFICATION: this adapter is exercised by the Forge no-model dry run; until that
// passes, cells must not run (run-cell refuses a Forge cell without forge.qualifiedAt).
import { execFileSync, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
import { mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, copyFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { ImportBenchmarkMonitor } from '../benchmark-import-monitor.mjs';

const EXCLUDE = [
  ':!.repos',
  ':!apps/mobile/modules/t3-terminal/Vendor',
  ':!.forge',
  ':!.nforge',
  ':!node_modules',
  ':!**/node_modules',
];

export function forgeArm(config) {
  const { url, projectId, cli, deployment } = config;
  const X = { url, projectId };
  const nf = (root, verb, body, extra = []) => {
    const out = execFileSync(
      '/usr/local/bin/node',
      [cli, 'agent', root, verb, ...extra, JSON.stringify(body)],
      {
        encoding: 'utf8',
        maxBuffer: 64 << 20,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const line = out
      .split('\n')
      .filter(l => l.startsWith('{'))
      .at(-1);
    return line ? JSON.parse(line) : { raw: out.slice(-2000) };
  };
  const nfAsync = async (root, verb, body, extra = []) => {
    const { stdout } = await run(
      '/usr/local/bin/node',
      [cli, 'agent', root, verb, ...extra, JSON.stringify(body)],
      { maxBuffer: 64 << 20 },
    );
    const line = stdout
      .split('\n')
      .filter(l => l.startsWith('{'))
      .at(-1);
    return line ? JSON.parse(line) : { raw: stdout.slice(-2000) };
  };
  const arm = {
    name: 'forge',
    nf,
    /** Start a Lane on main and materialize it at root (outside agent timing). */
    async startLane(anchor, root, outcome) {
      mkdirSync(anchor, { recursive: true });
      const started = await nfAsync(anchor, 'start', { ...X, operationId: randomUUID(), outcome });
      // Same extraction as the lead's lane.sh: the first laneId anywhere in the receipt.
      const laneId = JSON.stringify(started).match(/"laneId":"([0-9a-f-]{36})"/)?.[1];
      if (!laneId) throw Error(`BENCH_FORGE_START ${JSON.stringify(started).slice(0, 500)}`);
      await nfAsync(root, 'open', { ...X, laneId });
      if (!existsSync(join(root, '.forge', 'hosted-lane.json'))) throw Error('BENCH_FORGE_OPEN');
      return laneId;
    },
    status(root, laneId) {
      return nf(root, 'status', { laneId });
    },
    /** System of record: the Lane's saved head is in accepted main. */
    landing(root, laneId) {
      const s = arm.status(root, laneId).result?.lane ?? {};
      return {
        landed: Boolean(s.merged || s.state === 'landed' || s.state === 'completed'),
        state: s.state ?? null,
        mergedInto: s.mergedInto ?? null,
        acceptedAt: s.acceptedAt ?? s.landedAt ?? null,
        lastCheck: s.lastCheck ?? null,
      };
    },
    /** By address from an empty directory: an agent's unsaved edits never block it
     * (LANE_DIRTY) and a stale checkout baseline never fails it (WORK_STALE). */
    abandon(root, laneId, reason = 'bench cell cleanup') {
      const empty = join(dirname(root), '.abandon');
      mkdirSync(empty, { recursive: true });
      try {
        return nf(empty, 'abandon', { ...X, laneId, reason });
      } catch (error) {
        return { error: String(error.stdout ?? error.message).slice(-500) };
      }
    },
    removeRoot(root) {
      rmSync(root, { recursive: true, force: true });
      rmSync(root + '.forge-client', { recursive: true, force: true });
      rmSync(root + '.forge-metrics.jsonl', { force: true });
    },
    binDir(bin) {
      mkdirSync(bin, { recursive: true });
      const file = join(bin, 'nforge');
      writeFileSync(file, `#!/bin/bash\nexec /usr/local/bin/node ${JSON.stringify(cli)} "$@"\n`);
      chmodSync(file, 0o755);
      return {};
    },
    /** Changed paths of a materialized main vs the base commit (sparse paths excluded). */
    diffFromBase(meta, baseCommit, root) {
      const env = { ...process.env, GIT_INDEX_FILE: join(meta, '.git', `forge-diff-${process.pid}.index`) };
      execFileSync('git', ['-C', meta, 'read-tree', baseCommit], { env });
      execFileSync('git', ['-C', meta, `--work-tree=${root}`, 'add', '-A', '--', '.', ...EXCLUDE], { env });
      const out = execFileSync(
        'git',
        ['-C', meta, 'diff', '--cached', '--name-status', '--no-renames', baseCommit],
        { env, encoding: 'utf8' },
      );
      unlinkSync(env.GIT_INDEX_FILE);
      return out
        .split('\n')
        .filter(Boolean)
        .map(line => ({ status: line[0], path: line.slice(2) }));
    },
    /** Reset main to base content with one landing: restore modified/deleted, drop added. */
    async reset({ meta, baseCommit, baseCheckout, anchor, root }) {
      const laneId = await arm.startLane(anchor, root, 'bench reset to base');
      const changes = arm.diffFromBase(meta, baseCommit, root);
      for (const { status, path } of changes) {
        const target = join(root, path);
        if (status === 'A') rmSync(target, { force: true });
        else {
          mkdirSync(dirname(target), { recursive: true });
          copyFileSync(join(baseCheckout, path), target);
        }
      }
      let landed = null;
      if (changes.length)
        landed = await nfAsync(root, 'land', { laneId, message: 'bench: reset main to base' }, ['--save']);
      const after = arm.diffFromBase(meta, baseCommit, root);
      arm.abandon(root, laneId);
      arm.removeRoot(root);
      return {
        laneId,
        restored: changes.length,
        phase: landed?.result?.phase ?? landed?.phase ?? null,
        remaining: after.length,
      };
    },
  };
  return arm;
}

/** Project-attributed Convex usage during a cell, from the provider log stream. */
export function convexMeter({ deployment, projectId, name, cwd }) {
  const monitor = new ImportBenchmarkMonitor({ projectId, name, since: Date.now() });
  monitor.usage = {
    databaseReadDocuments: 0,
    databaseWriteDocuments: 0,
    databaseIoReadBytes: 0,
    databaseIoWriteBytes: 0,
    networkEgressBytes: 0,
  };
  const deploymentWide = { completions: 0, ioBytes: 0, egressBytes: 0 };
  const child = spawn('npx', ['convex', 'logs', '--deployment', deployment, '--jsonl', '--success'], {
    cwd,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let closed = false;
  child.on('close', () => (closed = true));
  createInterface({ input: child.stdout }).on('line', line => {
    if (!line.startsWith('{')) return;
    try {
      const event = JSON.parse(line);
      if (event.kind === 'Completion' && !event.cachedResult) {
        deploymentWide.completions++;
        deploymentWide.ioBytes +=
          (event.usageStats?.databaseIoReadBytes ?? 0) + (event.usageStats?.databaseIoWriteBytes ?? 0);
        deploymentWide.egressBytes += event.usageStats?.networkEgressBytes ?? 0;
      }
      monitor.observe(event);
    } catch {}
  });
  return {
    stop() {
      child.kill();
      const r = monitor.report();
      const ioGb = (monitor.usage.databaseIoReadBytes + monitor.usage.databaseIoWriteBytes) / 1e9;
      return {
        projectExecutions: r.total,
        failures: r.failures,
        usage: monitor.usage,
        streamClosedEarly: closed,
        deploymentWide,
        // Convex list rates (brief): calls $2.2/M, DB I/O $0.22/GB, egress $0.132/GB.
        costUsd: (r.total * 2.2) / 1e6 + ioGb * 0.22 + (monitor.usage.networkEgressBytes / 1e9) * 0.132,
      };
    },
  };
}
