#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// GitHub import of the bench fork at the base commit into a NEW Forge project (setup step
// forge-project). The import builds a born-hosted, server-authority main that agents can land
// on; `nforge host` of a Git checkout does not (it seeds in Git format, so `mainReady` stays
// false). The CLI has no import command yet (5775aef1), so this calls the same actions the web
// import does, with the CLI's own login and deadline client from this built checkout's dist/
// (setup runs from a built checkout).
//   node forge-import.mjs JOURNAL.json '{"url":..,"ref":..,"name":..,"deployment":..}'
// Resumable: the journal keeps the operation id (start is idempotent on it) and the job id.
// Prints one JSON line per poll and a final {projectId, phase, error, calls}.
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { makeFunctionReference } from 'convex/server';
import { resolveAuthToken } from '../../dist/auth-store.js';
import { deadlineConvexClient } from '../../dist/network-convex-client.js';

export const POLL_MS = 20_000;
export const DEADLINE_MS = 30 * 60_000;
const TERMINAL = new Set(['ready', 'failed', 'cancelled']);

export async function importProject({ client, ref, journalPath, spec, now = Date.now, sleep, log }) {
  const journal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')) : {};
  const save = () => {
    writeFileSync(journalPath + '.tmp', JSON.stringify(journal, null, 1) + '\n');
    renameSync(journalPath + '.tmp', journalPath);
  };
  let calls = 0;
  if (journal.status?.phase === 'ready' && journal.status.projectId)
    return { ...pick(journal.status), calls };
  journal.operationId ??= randomUUID();
  journal.startedAt ??= new Date(now()).toISOString();
  journal.spec = spec;
  save();
  if (!journal.jobId) {
    journal.jobId = await client.action(ref('projectGithubImport:start'), {
      operationId: journal.operationId,
      url: spec.url,
      ref: spec.ref,
      name: spec.name,
    });
    calls++;
    save();
  }
  const deadline = now() + DEADLINE_MS;
  let s;
  for (;;) {
    s = await client.action(ref('projectGithubImport:status'), { id: journal.jobId });
    calls++;
    log?.(
      JSON.stringify({
        at: new Date(now()).toISOString(),
        phase: s?.phase,
        done: s?.completed,
        total: s?.total,
      }),
    );
    if (!s || s.error || TERMINAL.has(s.phase) || now() > deadline) break;
    await sleep(POLL_MS);
  }
  journal.status = s;
  journal.calls = (journal.calls ?? 0) + calls;
  journal.endedAt = new Date(now()).toISOString();
  save();
  return { ...pick(s), calls };
}

const pick = s => ({
  projectId: s?.projectId ?? null,
  phase: s?.phase ?? null,
  error: s?.error ?? null,
  commit: s?.commit ?? null,
  files: s?.total ?? null,
  bytes: s?.totalBytes ?? null,
  report: s?.report ?? null,
});

async function main([journalPath, specJson]) {
  const spec = JSON.parse(specJson);
  const token = resolveAuthToken(spec.deployment);
  if (!token) throw Error(`AUTH_REQUIRED: run \`nforge auth login --deployment ${spec.deployment}\``);
  const client = deadlineConvexClient(spec.deployment, {});
  client.setAuth(token);
  const r = await importProject({
    client,
    ref: makeFunctionReference,
    journalPath,
    spec,
    sleep: ms => new Promise(res => setTimeout(res, ms)),
    log: line => console.log(line),
  });
  console.log(JSON.stringify(r));
  return r.phase === 'ready' && r.projectId ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  process.exitCode = await main(process.argv.slice(2));
