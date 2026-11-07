// B1.5d Forge arm: hosted project on t3code, a Lane per task, `land --save` with the
// project's `verify` check (`bash .bench/ci.sh`) on GitHub Actions.
// Every harness call here is async: workers never block one another, and agents' nforge
// goes through broker.mjs in its own process, so no harness work can delay an agent.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { networkFetch } from '../../dist/network-fetch.js';
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  appendFileSync,
  chmodSync,
  mkdirSync,
  realpathSync,
} from 'node:fs';
import { rm, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as wait } from 'node:timers/promises';
import { archiveThenRemove } from './evidence.mjs';
import { cliError } from './receipts.mjs';

const run = promisify(execFile);

export const TERMINAL = new Set([
  'landed',
  'ready',
  'terminal-failed',
  'cancelled',
  'superseded',
  'abandoned',
]);
/** A submission is done only when its phase is terminal and the server is not still working
 * on it: `ready` with observation.state `pending` (pendingReason `queued`) is a passed check
 * still waiting to land after main moved (seen 2026-11-01 n3-r1-dry-a4 t27514: ready 12:23,
 * landed 12:39). */
export const settled = (phase, observation) => TERMINAL.has(phase) && observation !== 'pending';
// Forge metadata and dependency links never count as source; gitlinks (submodule pointers
// without a .gitmodules entry under .repos) are added per base by gitlinks().
const METADATA = [':!.forge', ':!.nforge', ':!node_modules', ':!**/node_modules'];

export const readCalls = file =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
    : [];

/** Every wrapper call is retained before exec and closed only after its receipt is logged. */
export function inProgressCalls(callLog) {
  const active = new Map();
  for (const call of readCalls(callLog + '.progress.jsonl')) {
    if (call.endedAt) active.delete(call.callId);
    else active.set(call.callId, call);
  }
  return [...active.values()];
}

/** Lanes a sync conflict opened for this workspace (<root>.forge-client/lanes/<id>). */
export function resolveLanes(root) {
  const lanesDir = `${root}.forge-client/lanes`;
  if (!existsSync(lanesDir)) return [];
  return readdirSync(lanesDir)
    .flatMap(d => {
      try {
        const file = join(lanesDir, d, '.forge', 'hosted-lane.json');
        return [{ laneId: JSON.parse(readFileSync(file, 'utf8')).selection.laneId, dir: join(lanesDir, d) }];
      } catch {
        return [];
      }
    })
    .filter(l => l.laneId);
}

/** Lanes the ledger opened and never closed (abandoned). */
export function openLanes(ledger) {
  if (!ledger || !existsSync(ledger)) return [];
  const state = new Map();
  for (const line of readFileSync(ledger, 'utf8').split('\n').filter(Boolean)) {
    const e = JSON.parse(line);
    if (e.op === 'open') state.set(e.laneId, e);
    else state.delete(e.laneId);
  }
  return [...state.values()];
}

export function forgeArm(config, { callLog, ws, ledger = null, cellDir = dirname(callLog) }) {
  // Every Lane the harness starts or finds (an agent's resolve Lanes) is logged, and closed
  // when abandoned, so a crashed cell's Lanes are found and closed before the next cell
  // (2026-11-01: a resolve Lane left by a SIGTERMed cell raised notices in the next one).
  const log = (op, laneId, extra = {}) =>
    ledger &&
    appendFileSync(ledger, JSON.stringify({ op, laneId, at: new Date().toISOString(), ...extra }) + '\n');
  const { url, projectId, cli } = config;
  const X = { url, projectId };
  const nf = async (root, verb, body, extra = []) => {
    const { stdout } = await run(
      '/usr/local/bin/node',
      [cli, 'agent', root, verb, ...extra, JSON.stringify(body)],
      {
        maxBuffer: 64 << 20,
      },
    );
    const line = stdout
      .split('\n')
      .filter(l => l.startsWith('{'))
      .at(-1);
    return line ? JSON.parse(line) : { raw: stdout.slice(-2000) };
  };
  const anchor = join(ws, '.anchor');
  let broker = null;
  const arm = {
    name: 'forge',
    nf,
    /** Start a Lane on main and materialize it at root (outside agent timing). */
    /** New Lane, then its checkout at root; `phases` gets each step's seconds. */
    async startLane(root, outcome, phases = {}, task = null) {
      let t = Date.now();
      await mkdir(anchor, { recursive: true });
      const started = await nf(anchor, 'start', { ...X, operationId: randomUUID(), outcome });
      const laneId = JSON.stringify(started).match(/"laneId":"([0-9a-f-]{36})"/)?.[1];
      if (!laneId) throw Error(`BENCH_FORGE_START ${JSON.stringify(started).slice(0, 500)}`);
      log('open', laneId, { outcome: outcome.slice(0, 80), root, callLog, task });
      phases.start = (Date.now() - t) / 1000;
      t = Date.now();
      await nf(root, 'open', { ...X, laneId });
      if (!existsSync(join(root, '.forge', 'hosted-lane.json'))) throw Error('BENCH_FORGE_OPEN');
      phases.open = (Date.now() - t) / 1000;
      return laneId;
    },
    async observe(operationId) {
      try {
        await mkdir(anchor, { recursive: true });
        return (await nf(anchor, 'observe', { ...X, operationId })).result?.submission ?? null;
      } catch (error) {
        return { error: cliError(error) };
      }
    },
    /** Executed landing actions only; source/coordination operations stay in the call log. */
    taskOps(task) {
      return [
        ...new Set(
          readCalls(callLog)
            .filter(c => c.task === task)
            .flatMap(c => (c.operations ?? []).filter(o => ['finish', 'land'].includes(o.action)))
            .map(o => o.operationId)
            .filter(Boolean),
        ),
      ];
    },
    /** System of record: the server submissions behind the agent's operations. Waits (bounded)
     * until none is in flight, so a landing that finishes after the agent exits still counts
     * and is never abandoned mid-check (B7). */
    async landing(
      task,
      laneId,
      { deadlineMs = 20 * 60_000, pollMs = 20_000, agentExitedAt = Date.now() } = {},
    ) {
      const until = Date.now() + deadlineMs;
      for (;;) {
        // No Lane-filtered submission read exists in the hosted CLI. Wait for ALL
        // task calls (including resolve Lanes/source prep), then re-read server handles.
        const calls = inProgressCalls(callLog).filter(c => c.task === task);
        if (calls.length) {
          if (Date.now() >= until)
            return {
              landed: false,
              state: 'in-flight-at-deadline',
              laneId,
              inFlight: calls.map(c => `call:${c.callId}`),
              operations: [],
              acceptedAt: null,
            };
          await wait(Math.min(pollMs, Math.max(0, until - Date.now())));
          continue;
        }
        const seen = [];
        let landed = null;
        for (const operationId of arm.taskOps(task)) {
          const s = await arm.observe(operationId);
          if (!s?.phase) {
            seen.push({ operationId, error: s?.error ?? 'NOT_A_SUBMISSION' });
            continue;
          }
          seen.push({
            operationId,
            phase: s.phase,
            observation: s.observation?.state ?? null,
            timing: s.timing ?? null,
            error: s.error ?? null,
          });
          if (s.phase === 'landed' && !landed) landed = { operationId, s };
        }
        const inFlight = seen.filter(o =>
          o.phase
            ? !settled(o.phase, o.observation)
            : o.error !== 'NOT_A_SUBMISSION' && o.error?.code !== 'NOT_FOUND',
        );
        if (landed && !inFlight.length) {
          const at = landed.s.timing?.committedAt ?? landed.s.timing?.settledAt ?? null;
          return {
            landed: true,
            state: 'landed',
            operationId: landed.operationId,
            receiptId: landed.s.acceptance?.receiptId ?? null,
            mainHead: landed.s.acceptance?.head ?? null,
            acceptedAt: at,
            submittedAt: landed.s.timing?.submittedAt ?? null,
            landedAfterAgentExit: at ? Date.parse(at) > agentExitedAt : null,
            operations: seen,
            laneId,
          };
        }
        if (!inFlight.length || Date.now() >= until)
          return {
            landed: false,
            state: inFlight.length ? 'in-flight-at-deadline' : (seen.at(-1)?.phase ?? null),
            inFlight: inFlight.map(o => o.operationId),
            operations: seen,
            acceptedAt: null,
            laneId,
          };
        await wait(Math.min(pollMs, Math.max(0, until - Date.now())));
      }
    },
    /** By address from an empty directory (never blocked by unsaved edits or a stale base).
     * Refuses while a landing of this Lane is in flight. */
    async abandon(root, laneId, landing, reason = 'bench cell cleanup') {
      if (landing?.inFlight?.length) return { skipped: 'landing in flight', inFlight: landing.inFlight };
      return arm.abandonById(laneId, reason, dirname(root));
    },
    /** Every Lane of one task, its own and the resolve Lanes its agent opened, once nothing
     * of it is in flight. A landed Lane is closed too: abandoning only ends the Lane (its
     * landed commits stay on main), so no Lane of a finished task can raise notices later. */
    async closeTask(root, laneId, landing) {
      if (!landing) return { skipped: 'landing state unknown' };
      if (landing.inFlight?.length) return { skipped: 'landing in flight', inFlight: landing.inFlight };
      const calls = inProgressCalls(callLog).filter(c => c.root === root);
      if (calls.length) return { skipped: 'calls in flight', inFlight: calls.map(c => `call:${c.callId}`) };
      const ids = [...new Set([laneId, ...resolveLanes(root).map(r => r.laneId)].filter(Boolean))];
      for (const id of ids.slice(1)) log('open', id, { resolveOf: laneId });
      const out = {};
      for (const id of ids) out[id] = await arm.abandonById(id, 'bench cell cleanup', dirname(root));
      return out;
    },
    async abandonById(laneId, reason = 'bench cell cleanup', near = ws) {
      // A later cell must also preserve calls left running by abnormal cleanup.
      const opened = openLanes(ledger).find(l => l.laneId === laneId);
      if (opened?.callLog && inProgressCalls(opened.callLog).some(c => c.root === opened.root))
        return { error: 'Task CLI call still in flight; Lane kept' };
      const empty = join(near, '.abandon');
      await mkdir(empty, { recursive: true });
      try {
        const r = await nf(empty, 'abandon', { ...X, laneId, reason });
        log('closed', laneId, { abandoned: true });
        return r;
      } catch (error) {
        // The CLI prints its structured error on stderr; `error` stays a string for callers
        // that slice or test it, with the decoded code and message kept beside it.
        const { code, message } = cliError(error);
        return { error: `${code}: ${message}`.slice(-500), code, message };
      }
    },
    async removeRoot(root, reason = 'remove-root') {
      return archiveThenRemove({
        root,
        cellDir,
        reason,
        remove: async () => {
          await rm(root, { recursive: true, force: true });
          await rm(root + '.forge-client', { recursive: true, force: true });
          await rm(root + '.forge-metrics.jsonl', { force: true });
        },
      });
    },
    /** Start the relay process and write the agents' `nforge` client into bin. */
    async binDir(bin) {
      mkdirSync(bin, { recursive: true });
      const child = spawn('/usr/local/bin/node', [join(import.meta.dirname, 'broker.mjs'), cli, callLog], {
        stdio: ['pipe', 'pipe', 'inherit'],
      });
      const first = await new Promise((done, fail) => {
        createInterface({ input: child.stdout }).once('line', done);
        child.once('exit', code => fail(Error(`BENCH_BROKER_EXIT ${code}`)));
      });
      broker = { child, ...JSON.parse(first) };
      const client = join(bin, 'nforge-client.mjs');
      writeFileSync(client, readFileSync(new URL('./relay-client.mjs', import.meta.url), 'utf8'));
      const file = join(bin, 'nforge');
      writeFileSync(file, `#!/bin/bash\nexec /usr/local/bin/node ${JSON.stringify(client)} "$@"\n`);
      chmodSync(file, 0o755);
      return broker;
    },
    /** Env for one agent confined to root; its PATH/toolchain env reaches its CLI calls. */
    async agentEnv(root, task, env) {
      const token = randomUUID();
      const base = `http://127.0.0.1:${broker.port}`;
      const res = await networkFetch(`${base}/register`, {
        method: 'POST',
        body: JSON.stringify({ admin: broker.admin, token, root: realpathSync(root), task, env }),
      });
      if (!(await res.json()).ok) throw Error('BENCH_BROKER_REGISTER');
      return { BENCH_NFORGE_URL: `${base}/`, BENCH_NFORGE_TOKEN: token };
    },
    /** Test cleanup only: end the relay and any CLI call it still runs (stopBroker drains them). */
    abortBroker() {
      broker?.child.kill('SIGTERM');
    },
    stopBroker() {
      broker?.child.stdin.end();
      // Let outstanding CLI children publish their receipts even after abnormal exit.
      // Closing stdin stops admission; broker.mjs drains existing requests and children.
    },
    diffFromBase,
    /** Harness-only `land --save` that answers the shipped defaults' refusals the way an
     * agent would (overlap -> ack accept-order; preflight require -> preflight), then retries. */
    async landAnswering(root, laneId, message) {
      for (let attempt = 1; ; attempt++) {
        try {
          return await nf(root, 'land', { laneId, message }, ['--save']);
        } catch (error) {
          const out = String(error.stdout ?? '') + String(error.stderr ?? '');
          const code = out.match(/"code":"([A-Z_]+)"/)?.[1];
          if (attempt >= 4 || !['OVERLAP_UNANSWERED', 'PREFLIGHT_REQUIRED'].includes(code)) throw error;
          if (code === 'OVERLAP_UNANSWERED') await nf(root, 'ack', { laneId, choice: 'accept-order' });
          else await nf(root, 'preflight', { laneId });
        }
      }
    },
    /** Reset main to the base tree with one landing, then prove it on a fresh Lane of main:
     * refuses (throws) unless main equals the base exactly (S4). */
    async reset({ meta, baseCommit, root }) {
      const laneId = await arm.startLane(root, 'bench reset to base');
      const changes = await arm.diffFromBase(meta, baseCommit, root);
      const added = changes.filter(c => c.status === 'A').map(c => c.path);
      const restore = changes.filter(c => c.status !== 'A').map(c => c.path);
      for (const path of added) await rm(join(root, path), { force: true });
      const index = join(meta, '.git', `forge-reset-${randomUUID()}.index`);
      try {
        for (let i = 0; i < restore.length; i += 200)
          await run(
            'git',
            ['-C', meta, `--work-tree=${root}`, 'checkout', baseCommit, '--', ...restore.slice(i, i + 200)],
            {
              env: { ...process.env, GIT_INDEX_FILE: index },
            },
          );
      } finally {
        await rm(index, { force: true });
      }
      let phase = null,
        s = null;
      if (changes.length) {
        // `land --save` may return once the landing is submitted: the submission is the
        // record. Wait (bounded) for a terminal phase; never abandon a Lane mid-landing (B7).
        const landed = await arm.landAnswering(root, laneId, 'bench: reset main to base');
        const operationId = JSON.stringify(landed).match(/"operationId":"([0-9a-f-]{36})"/)?.[1];
        const until = Date.now() + 30 * 60_000;
        for (;;) {
          s = operationId ? await arm.observe(operationId) : null;
          phase = s?.phase ?? s?.error ?? null;
          if (settled(s?.phase, s?.observation?.state) || !operationId || Date.now() > until) break;
          await wait(15_000);
        }
        if (!settled(s?.phase, s?.observation?.state))
          throw Error(`BENCH_RESET_NOT_LANDED still ${phase} (Lane ${laneId} kept)`);
      }
      await arm.abandon(root, laneId);
      await arm.removeRoot(root);
      if (changes.length && phase !== 'landed') throw Error(`BENCH_RESET_NOT_LANDED ${phase}`);
      // Verify on main itself, not on the reset Lane's own tree.
      const verify = root + '-verify';
      const verifyLane = await arm.startLane(verify, 'bench reset verification');
      const remaining = await arm.diffFromBase(meta, baseCommit, verify);
      const lane = JSON.parse(readFileSync(join(verify, '.forge', 'hosted-lane.json'), 'utf8'));
      await arm.abandon(verify, verifyLane);
      await arm.removeRoot(verify);
      if (remaining.length) throw Error(`BENCH_RESET_MISMATCH ${remaining.length} paths differ from base`);
      return {
        laneId,
        verifyLaneId: verifyLane,
        restored: changes.length,
        phase,
        remaining: 0,
        verifiedMainHead: lane.selection?.base?.head ?? null,
      };
    },
  };
  return arm;
}

/** Changed paths of a materialized tree vs the base commit, whole tree (.repos included).
 * Works on any directory (a Lane root or a git workspace: git never adds a nested .git). */
export async function diffFromBase(meta, baseCommit, root, scope = null) {
  const env = { ...process.env, GIT_INDEX_FILE: join(meta, '.git', `forge-diff-${randomUUID()}.index`) };
  const git = args => run('git', ['-C', meta, ...args], { env, maxBuffer: 256 << 20 });
  try {
    await git(['read-tree', baseCommit]);
    // A requested sparse path may be absent in both trees; Git add rejects that
    // unmatched literal. It carries no change, while tracked absences are deletions.
    const tracked = scope === null ? [] : (await git(['ls-files', '-z'])).stdout.split('\0');
    const selected = scope?.filter(
      path =>
        existsSync(join(root, path)) || tracked.some(file => file === path || file.startsWith(path + '/')),
    );
    const pathspec = [
      ...(selected === undefined ? ['.'] : selected.map(p => `:(literal)${p}`)),
      ...METADATA,
      ...(await gitlinks(meta, baseCommit)).map(p => `:!${p}`),
    ];
    if (selected === undefined || selected.length)
      await git([`--work-tree=${root}`, 'add', '-A', '-f', '--', ...pathspec]);
    const { stdout } = await git(['diff', '--cached', '--name-status', '--no-renames', baseCommit]);
    return stdout
      .split('\n')
      .filter(Boolean)
      .map(line => ({ status: line[0], path: line.slice(2) }));
  } finally {
    await rm(env.GIT_INDEX_FILE, { force: true });
  }
}

const gitlinkCache = new Map();
/** Submodule pointers in the base tree: Forge stores them as metadata, Git as gitlinks. */
export async function gitlinks(meta, commit) {
  if (!gitlinkCache.has(commit)) {
    const { stdout } = await run('git', ['-C', meta, 'ls-tree', '-r', commit], { maxBuffer: 256 << 20 });
    gitlinkCache.set(
      commit,
      stdout
        .split('\n')
        .filter(l => l.startsWith('160000 '))
        .map(l => l.split('\t')[1]),
    );
  }
  return gitlinkCache.get(commit);
}
