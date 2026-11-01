#!/usr/bin/env node
// B1.5d nforge relay, in its own process so nothing the harness does (observe, abandon,
// deleting a 29k-file Lane folder) can delay an agent's call. Agents' `nforge` posts here:
// macOS sandboxes cannot exec setuid /bin/ps, which the CLI needs for its process identity.
// The relay runs the real CLI only when the call's cwd and ROOT are inside the calling
// agent's own workspace (one token per agent), with that agent's PATH and toolchain env.
// Usage (harness only): node broker.mjs CLI CALL_LOG -> prints {"port","admin"} then serves.
import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const OPERATION_ID = /"?operationId"?[:\s]+"?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;
// Env an agent passes through to its CLI call; everything else is the relay's own.
const PASS = ['PATH', 'VP_HOME', 'npm_config_store_dir', 'FORGE_OBJECT_CACHE'];

/** JSON receipts printed by one CLI call (one per line). */
function receipts(text) {
  const out = [];
  for (const line of text.split('\n'))
    if (line.startsWith('{'))
      try {
        out.push(JSON.parse(line));
      } catch {}
  return out;
}

/** Overlap notices returned to the caller, and overlap answers it sent (metric 4). */
export function coordinationOf(args, output) {
  const notices = [];
  for (const r of receipts(output)) {
    const n = r.overlapNotice ?? r.result?.overlapNotice;
    for (const item of n?.items ?? [])
      notices.push({
        noticeId: item.noticeId,
        file: item.file,
        with: item.with ?? [],
        // Blocking or advisory (overlap precision, Issue 74b809cc); null on older servers.
        class: item.class ?? null,
        reason: item.reason ?? null,
      });
    for (const item of r.unacknowledgedOverlaps?.items ?? [])
      notices.push({
        noticeId: item.noticeId ?? null,
        file: item.file,
        with: item.participants ?? [],
        class: item.class ?? null,
        reason: item.reason ?? null,
      });
    // A land refused until the notice is answered names its files only in the message. Only
    // the new gate wording ("blocking overlap notice(s)") states the class; older servers
    // refuse on any overlap, so their refusals stay unclassified.
    if (r.error?.code === 'OVERLAP_UNANSWERED') {
      const message = String(r.error.message);
      const files = message.match(/overlap notice\(s\) on (.+?) before landing/)?.[1];
      const cls = /\bblocking overlap notice\(s\)/.test(message) ? 'blocking' : null;
      for (const file of files?.split(', ') ?? [null])
        notices.push({ noticeId: null, file, with: [], refusal: true, class: cls, reason: cls && 'refused' });
    }
  }
  const answers = [];
  if (['ack', 'overlap-acks'].includes(args[2])) {
    let body = {};
    try {
      body = JSON.parse(args.at(-1));
    } catch {}
    for (const a of body.answers ?? [body])
      answers.push({ noticeId: a.noticeId ?? null, choice: a.choice ?? 'accept-order' });
  }
  return { notices, answers };
}

export function startBroker(cli, callLog, { now = () => new Date().toISOString() } = {}) {
  const admin = randomUUID();
  const agents = new Map(); // token -> { root, env, task }
  // The agent's workspace and its own client folder: a sync conflict opens a resolve Lane at
  // <root>.forge-client/lanes/<id>, where the agent edits and runs resolve and finish.
  const inside = (root, p) => p === root || p.startsWith(root + '/') || p.startsWith(root + '.forge-client/');
  const server = createServer((req, res) => {
    const receivedAt = now();
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      const reply = value => res.end(JSON.stringify(value));
      let call;
      try {
        call = JSON.parse(body);
      } catch {
        return reply({ stdout: '', stderr: 'bench relay: bad request\n', code: 2 });
      }
      if (req.url === '/register') {
        if (call.admin !== admin) return reply({ ok: false });
        agents.set(call.token, { root: call.root, env: call.env ?? {}, task: call.task ?? null });
        return reply({ ok: true });
      }
      if (req.url === '/ping') return reply({ ok: true, at: now() });
      const { token, cwd, args = [], sentAt = null } = call;
      const agent = agents.get(token);
      const target = ['agent', 'x'].includes(args[0]) && args[1] ? resolve(cwd, args[1]) : cwd;
      if (!agent || !inside(agent.root, resolve(cwd)) || !inside(agent.root, target))
        return reply({ stdout: '', stderr: 'bench: nforge is limited to your workspace\n', code: 2 });
      const env = { ...process.env };
      for (const key of PASS) if (agent.env[key]) env[key] = agent.env[key];
      const execStartedAt = now();
      execFile(
        '/usr/local/bin/node',
        [cli, ...args],
        { cwd, env, maxBuffer: 64 << 20 },
        (error, stdout, stderr) => {
          const output = `${stdout}\n${stderr}`;
          const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
          // Durable record of every agent nforge call: the landing operations, refusals and
          // coordination events are read from here (scoring, contamination, metric 4).
          appendFileSync(
            callLog,
            JSON.stringify({
              task: agent.task,
              root: agent.root,
              cwd,
              sentAt,
              receivedAt,
              startedAt: execStartedAt,
              endedAt: now(),
              verb: args.filter((a, i) => i !== 1 && !String(a).startsWith('{')).join(' '),
              args: args.slice(2),
              code,
              operationIds: [...new Set([...output.matchAll(OPERATION_ID)].map(m => m[1]))],
              errorCodes: [...new Set([...output.matchAll(/"code":"([A-Z_]+)"/g)].map(m => m[1]))],
              // Every id the agent was shown (contamination: ids it may legitimately use).
              ids: [
                ...new Set(
                  output.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [],
                ),
              ].slice(0, 500),
              conflictMarkers: /<<<<<<< lane/.test(output),
              // Both streams: a refused land prints its error JSON (and the gate's notices) on
              // stderr; reading stdout only lost every gate notice (n3-r1-dry-a4).
              ...coordinationOf(args, output),
            }) + '\n',
          );
          reply({ stdout, stderr, code });
        },
      );
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  return new Promise(done =>
    server.listen(0, '127.0.0.1', () => done({ server, admin, port: server.address().port })),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const [cli, callLog] = process.argv.slice(2);
  const { admin, port } = await startBroker(cli, callLog);
  process.stdout.write(JSON.stringify({ port, admin }) + '\n');
  // The harness owns this process: exit with it.
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
}
