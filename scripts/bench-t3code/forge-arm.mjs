// B1.5d Forge arm: hosted project imported from t3code@C (B1.5c), Lanes per task,
// `land --save` with the project's `verify` check (`bash .bench/ci.sh`) on GitHub Actions.
// QUALIFICATION: this adapter is exercised by the Forge no-model dry run; until that
// passes, cells must not run (run-cell refuses a Forge cell without forge.qualifiedAt).
import { execFileSync, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
import {
  appendFileSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
  existsSync,
  copyFileSync,
  unlinkSync,
  realpathSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
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

const OPERATION_ID = /"?operationId"?[:\s]+"?([0-9a-f-]{36})/g;

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
  // Agent workspace (realpath) -> land/finish operationIds seen by the nforge broker.
  const landOps = new Map();
  const workspaceKey = root => (existsSync(root) ? realpathSync(root) : resolve(root));
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
    /** System of record: the server's landing submission for the agent's own land/finish
     * operations (recorded by the nforge broker), read with `observe`. Lane `status`
     * carries no landing state. */
    /** Remember the operationIds in one land/finish call's output for this workspace. */
    recordLandOps(root, output) {
      const key = workspaceKey(root);
      const ops = landOps.get(key) ?? new Set();
      for (const [, id] of output.matchAll(OPERATION_ID)) ops.add(id);
      landOps.set(key, ops);
    },
    landing(root, laneId) {
      const ops = landOps.get(workspaceKey(root)) ?? new Set();
      const seen = [];
      for (const operationId of ops) {
        // An agent's refused or replaced attempt leaves ids that are not landing
        // operations (observe: NOT_FOUND); record them and keep looking.
        let s;
        try {
          s = nf(root, 'observe', { ...X, operationId }).result?.submission ?? {};
        } catch (error) {
          seen.push({
            operationId,
            error: String(error.stderr ?? error.message).match(/"code":"([A-Z_]+)"/)?.[1] ?? 'ERROR',
          });
          continue;
        }
        seen.push({ operationId, phase: s.phase ?? null });
        if (s.phase === 'landed')
          return {
            landed: true,
            state: 'landed',
            operationId,
            receiptId: s.acceptance?.receiptId ?? null,
            mainHead: s.acceptance?.head ?? null,
            acceptedAt: s.timing?.committedAt ?? s.timing?.settledAt ?? null,
            submittedAt: s.timing?.submittedAt ?? null,
            laneId,
          };
      }
      return { landed: false, state: seen.at(-1)?.phase ?? null, operations: seen, acceptedAt: null, laneId };
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
    /** Agents' `nforge` goes through an unsandboxed localhost broker: macOS sandboxes
     * cannot exec setuid /bin/ps, which the CLI needs for its process identity
     * (PROCESS_IDENTITY_UNAVAILABLE). The broker runs the real CLI only when the call's
     * cwd and ROOT are inside the calling agent's own workspace (token per agent). */
    async binDir(bin, callLog) {
      mkdirSync(bin, { recursive: true });
      const roots = new Map();
      const inside = (root, p) => p === root || p.startsWith(root + '/');
      const server = createServer((req, res) => {
        let body = '';
        req
          .on('data', d => (body += d))
          .on('end', () => {
            const reply = value => res.end(JSON.stringify(value));
            try {
              const { token, cwd, args } = JSON.parse(body);
              const root = roots.get(token);
              const target = ['agent', 'x'].includes(args[0]) && args[1] ? resolve(cwd, args[1]) : cwd;
              if (!root || !inside(root, resolve(cwd)) || !inside(root, target))
                return reply({ stdout: '', stderr: 'bench: nforge is limited to your workspace\n', code: 2 });
              const startedAt = new Date().toISOString();
              execFile(
                '/usr/local/bin/node',
                [cli, ...args],
                { cwd, maxBuffer: 64 << 20 },
                (error, stdout, stderr) => {
                  const output = `${stdout}\n${stderr}`;
                  if (['land', 'finish'].includes(args[2])) arm.recordLandOps(root, output);
                  // Durable record of every agent nforge call (verb, exit, operation ids,
                  // refusal codes) so a cell can be audited or re-scored after the fact.
                  if (callLog)
                    appendFileSync(
                      callLog,
                      JSON.stringify({
                        root,
                        startedAt,
                        endedAt: new Date().toISOString(),
                        verb: args
                          .slice(0, 3)
                          .filter(a => a !== args[1])
                          .join(' '),
                        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
                        operationIds: [...new Set([...output.matchAll(OPERATION_ID)].map(m => m[1]))],
                        errorCodes: [...new Set([...output.matchAll(/"code":"([A-Z_]+)"/g)].map(m => m[1]))],
                      }) + '\n',
                    );
                  reply({
                    stdout,
                    stderr,
                    code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
                  });
                },
              );
            } catch (error) {
              reply({ stdout: '', stderr: `bench broker: ${error.message}\n`, code: 2 });
            }
          });
      });
      server.requestTimeout = 0;
      server.headersTimeout = 0;
      await new Promise(done => server.listen(0, '127.0.0.1', done));
      server.unref();
      const client = join(bin, 'nforge-client.mjs');
      writeFileSync(
        client,
        // node:http, not fetch: undici's 300 s headers timeout would cut a long land --save.
        `import { request } from 'node:http';
const req = request(process.env.BENCH_NFORGE_URL, { method: 'POST' }, res => {
  let body = '';
  res.setEncoding('utf8').on('data', d => (body += d)).on('end', () => {
    const { stdout, stderr, code } = JSON.parse(body);
    process.stdout.write(stdout); process.stderr.write(stderr); process.exitCode = code;
  });
});
req.end(JSON.stringify({ token: process.env.BENCH_NFORGE_TOKEN, cwd: process.cwd(), args: process.argv.slice(2) }));
`,
      );
      const file = join(bin, 'nforge');
      writeFileSync(file, `#!/bin/bash\nexec /usr/local/bin/node ${JSON.stringify(client)} "$@"\n`);
      chmodSync(file, 0o755);
      return {
        /** Env for one agent confined to root. */
        agentEnv(root) {
          const token = randomUUID();
          roots.set(token, realpathSync(root));
          return {
            BENCH_NFORGE_URL: `http://127.0.0.1:${server.address().port}/`,
            BENCH_NFORGE_TOKEN: token,
          };
        },
      };
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
    /** Harness-only `land --save` that answers the shipped defaults' refusals the way an
     * agent would (overlapGate block -> ack accept-order; preflight require -> preflight),
     * then retries. Cell agents answer these themselves from the refusal message. */
    async landAnswering(root, laneId, message) {
      for (let attempt = 1; ; attempt++) {
        try {
          return await nfAsync(root, 'land', { laneId, message }, ['--save']);
        } catch (error) {
          const out = String(error.stdout ?? '') + String(error.stderr ?? '');
          const code = out.match(/"code":"([A-Z_]+)"/)?.[1];
          if (attempt >= 4 || !['OVERLAP_UNANSWERED', 'PREFLIGHT_REQUIRED'].includes(code)) throw error;
          console.log(`land refused ${code}; answering (attempt ${attempt})`);
          if (code === 'OVERLAP_UNANSWERED') await nfAsync(root, 'ack', { laneId, choice: 'accept-order' });
          else await nfAsync(root, 'preflight', { laneId });
        }
      }
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
      if (changes.length) landed = await arm.landAnswering(root, laneId, 'bench: reset main to base');
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
