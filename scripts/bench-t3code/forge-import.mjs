#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// GitHub import of the bench fork at the base commit into a NEW Forge project (setup step
// forge-project). The import builds a born-hosted, server-authority main that agents can land
// on; `nforge host` of a Git checkout does not (it seeds in Git format, so `mainReady` stays
// false). This predates `nforge import` (5775aef1), which now does the same; it calls the same
// actions the web import does, with the CLI's own login and deadline client from this built checkout's dist/
// (setup runs from a built checkout).
//   node forge-import.mjs JOURNAL.json '{"url":..,"ref":..,"name":..,"deployment":..}'
// Resumable: the journal keeps the operation id (start is idempotent on it) and the job id.
// Prints one JSON line per poll and a final {projectId, phase, error, calls}.
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isMainModule } from '../main-module.mjs';

export const POLL_MS = 20_000;
export const DEADLINE_MS = 30 * 60_000;
const TERMINAL = new Set(['ready', 'failed', 'cancelled']);

export async function importProject({
  client,
  ref,
  journalPath,
  spec,
  now = Date.now,
  sleep,
  log,
  onJournal,
}) {
  const journal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')) : {};
  const save = () => {
    writeFileSync(journalPath + '.tmp', JSON.stringify(journal, null, 1) + '\n');
    renameSync(journalPath + '.tmp', journalPath);
  };
  let calls = 0;
  const priorCalls = journal.calls ?? 0;
  const pending = error => {
    journal.calls = priorCalls + calls;
    save();
    return Object.assign(error instanceof Error ? error : Error(String(error)), {
      pendingImport: {
        journalPath,
        operationId: journal.operationId,
        jobId: journal.jobId ?? null,
        spec: journal.spec,
      },
    });
  };
  const action = async (name, args) => {
    for (let retries = 0; ; retries++) {
      const started = now();
      calls++;
      try {
        return await client.action(ref(name), args);
      } catch (error) {
        if (!['EXCHANGE_REQUEST_TIMEOUT', 'EXCHANGE_REQUEST_FAILED'].includes(error?.code)) {
          // This representation rejection is raised by tree listing before a job is begun.
          if (
            name === 'projectGithubImport:start' &&
            (error?.code ?? error?.data?.code) === 'GITHUB_SOURCE_UNSUPPORTED'
          )
            journal.rejection = { action: name, code: 'GITHUB_SOURCE_UNSUPPORTED' };
          throw pending(error);
        }
        const entry = { action: name, code: error.code, seconds: (now() - started) / 1000 };
        (journal.transportVoids ??= []).push(entry);
        journal.calls = priorCalls + calls;
        save();
        if (retries >= 8) throw pending(error);
        const waiting = now();
        await sleep(POLL_MS);
        entry.waitSeconds = (now() - waiting) / 1000;
        save();
      }
    }
  };
  if (
    journal.spec &&
    [...['url', 'ref', 'name'], ...(journal.spec.deployment ? ['deployment'] : [])].some(
      key => journal.spec[key] !== spec?.[key],
    )
  )
    throw pending(
      Object.assign(Error('Retained import belongs to another source or deployment.'), {
        code: 'WORK_OPERATION_CHANGED',
      }),
    );
  if (journal.status?.phase === 'ready' && journal.status.projectId)
    return { ...pick(journal.status), calls, transportVoids: journal.transportVoids ?? [] };
  journal.operationId ??= randomUUID();
  journal.startedAt ??= new Date(now()).toISOString();
  journal.spec = spec;
  save();
  await onJournal?.({
    operationId: journal.operationId,
    startedAt: journal.startedAt,
    spec: journal.spec,
    jobId: journal.jobId,
  });
  if (!journal.jobId) {
    delete journal.rejection;
    save();
    journal.jobId = await action('projectGithubImport:start', {
      operationId: journal.operationId,
      url: spec.url,
      ref: spec.ref,
      name: spec.name,
    });
    save();
  }
  const deadline = now() + DEADLINE_MS;
  let s;
  for (;;) {
    s = await action('projectGithubImport:status', { id: journal.jobId });
    journal.status = s;
    log?.(
      JSON.stringify({
        at: new Date(now()).toISOString(),
        phase: s?.phase,
        done: s?.completed,
        total: s?.total,
      }),
    );
    if (!s || s.error || TERMINAL.has(s.phase)) break;
    if (now() > deadline)
      throw pending(Error('ZOO_IMPORT_PENDING: readiness is unfinished; retain and replay the journal.'));
    await sleep(POLL_MS);
  }
  journal.status = s;
  journal.calls = priorCalls + calls;
  journal.endedAt = new Date(now()).toISOString();
  save();
  return { ...pick(s), calls, transportVoids: journal.transportVoids ?? [] };
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
  const [{ makeFunctionReference }, { resolveAuthToken }, { deadlineConvexClient }] = await Promise.all([
    import('convex/server'),
    import('../../dist/auth-store.js'),
    import('../../dist/network-convex-client.js'),
  ]);
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

if (isMainModule(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
