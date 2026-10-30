// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { makeFunctionReference } from 'convex/server';
import { ImportBenchmarkMonitor } from './benchmark-import-monitor.mjs';

/** Live adapter: admin is deployment-admin authenticated; owner is the ordinary
 * signed-in project owner. Credentials stay in those clients, never arguments.
 * Start the provider stream BEFORE starting the benchmark. Each event is the
 * Convex JSONL Completion/Progress object; tick() is a local clock, not a query.
 * On unknown IO replies, call stop() again: the same operation IDs are retained. */
export function importBenchmarkGuard({
  projectId,
  name,
  creationOperationId,
  journal = {},
  saveJournal = async () => {},
  since = journal.since ?? Date.now(),
  now = Date.now,
  admin,
  owner,
  stopWorkload = async () => {},
  deletionOperationId = journal.deleteRequest?.operationId ?? journal.deletionOperationId ?? randomUUID(),
  cancellationOperationId = journal.cancellationOperationId ?? randomUUID(),
}) {
  const monitor = new ImportBenchmarkMonitor({ projectId, name, creationOperationId, since, now });
  const target = () => {
    if (!monitor.target.projectId) throw Error('BENCHMARK_PROJECT_UNOBSERVED');
    return { projectId: monitor.target.projectId, name };
  };
  const ref = makeFunctionReference;
  let stopping,
    canceled = false,
    deleted = false,
    deleteRequest = journal.deleteRequest,
    quietStarted = false;
  const receipts = {
    cancellationOperationId,
    deletionOperationId,
    canceled: 0,
    scanned: 0,
    cancellationCalls: 0,
    statusCalls: 0,
    deletionCalls: 0,
  };
  const status = async () => {
    receipts.statusCalls++;
    return admin.query(ref('projectBenchmark:project'), target());
  };
  const cleanup = async () => {
    try {
      await stopWorkload();
    } catch {
      receipts.localStopFailed = true;
    }
    if (
      deleteRequest &&
      (deleteRequest.projectId !== target().projectId || deleteRequest.operationId !== deletionOperationId)
    )
      throw Error('BENCHMARK_OPERATION_CHANGED');
    Object.assign(journal, { ...target(), since, cancellationOperationId, deletionOperationId });
    await saveJournal(journal);
    if (!canceled) {
      let cursor = null;
      do {
        receipts.cancellationCalls++;
        const page = await admin.mutation(ref('projectBenchmark:cancelScheduled'), {
          ...target(),
          operationId: cancellationOperationId,
          cursor,
        });
        receipts.canceled += page.canceled;
        receipts.scanned += page.scanned;
        if (page.isDone) break;
        if (page.cursor === cursor) throw Error('BENCHMARK_CANCEL_CURSOR');
        cursor = page.cursor;
      } while (true);
      canceled = true;
    }
    let current = await status();
    if (current.purgeBlocked) throw Error(current.purgeBlocked);
    if (current.removal !== 'deleted') {
      for (let attempt = 0; attempt < 3; attempt++) {
        deleteRequest ??= {
          projectId: target().projectId,
          operationId: deletionOperationId,
          expectedRevision: current.revision,
        };
        journal.deleteRequest = deleteRequest;
        await saveJournal(journal);
        receipts.deletionCalls++;
        try {
          await owner.mutation(ref('projectLifecycle:permanentlyDelete'), deleteRequest);
          break;
        } catch (error) {
          // A definite revision rejection made no change. Unknown replies retain
          // the exact original request; only WORK_STALE can allocate fresh pins.
          if ((error.data?.code ?? error.code) !== 'WORK_STALE' || attempt === 2) throw error;
          current = await status();
          if (current.purgeBlocked) throw Error(current.purgeBlocked);
          deletionOperationId = randomUUID();
          receipts.deletionOperationId = deletionOperationId;
          journal.deletionOperationId = deletionOperationId;
          deleteRequest = undefined;
        }
      }
    } else {
      deleted = true;
      if (!quietStarted) {
        monitor.deleted();
        quietStarted = true;
      }
    }
  };
  const guard = {
    monitor,
    receipts,
    observe(log) {
      monitor.observe(log);
    },
    async tick() {
      monitor.advance(now());
      if (monitor.reason && !canceled) await guard.stop();
    },
    stop() {
      if (!stopping)
        stopping = cleanup().finally(() => {
          stopping = null;
        });
      return stopping;
    },
    async confirmDeleted() {
      // Finite caller-driven cleanup observation; never an installed poller.
      const current = await status();
      if (current.purgeBlocked) throw Error(current.purgeBlocked);
      if (current.removal !== 'deleted') return false;
      deleted = true;
      if (!quietStarted) {
        monitor.deleted();
        quietStarted = true;
      }
      return true;
    },
    report() {
      return { ...monitor.report(), deleted, receipts: { ...receipts } };
    },
  };
  return guard;
}

/** Read-only provider transport, like convex logs --jsonl, with explicit stream
 * failures and cursor continuity. HTTP log reads execute zero Convex functions.
 * Await ready before workload start. No raw logs or credentials are printed. */
export async function benchmarkLogStream({
  url,
  adminKey,
  signal,
  onEvent,
  fetchImpl = fetch,
  now = Date.now,
}) {
  const read = async cursor => {
    const response = await fetchImpl(`${url}/api/stream_function_logs?cursor=${cursor}`, {
      headers: { Authorization: `Convex ${adminKey}` },
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    if (!response.ok) throw Error('BENCHMARK_LOG_UNAVAILABLE');
    const page = await response.json();
    if (!Array.isArray(page.entries) || !Number.isFinite(page.newCursor) || page.newCursor < cursor)
      throw Error('BENCHMARK_LOG_SCHEMA');
    return page;
  };
  let cursor = (await read(0)).newCursor,
    observedThrough = now();
  return {
    get observedThrough() {
      return observedThrough;
    },
    async run() {
      while (!signal.aborted) {
        const page = await read(cursor);
        for (const event of page.entries) onEvent(event);
        cursor = page.newCursor;
        observedThrough = now();
        // The provider normally long-polls; avoid spinning with an empty immediate reply.
        if (!page.entries.length) await wait(250, undefined, { signal });
      }
    },
  };
}

/** One finite benchmark session. workload(signal) starts only after log cursor
 * initialization, and must honor abort to stop local clients on breach. Server
 * cancellation remains independent of that client's lifetime. */
export async function runGuardedImportBenchmark(options, workload) {
  const now = options.now ?? Date.now,
    pause = options.wait ?? wait;
  const session = new AbortController(),
    local = new AbortController();
  const guard = importBenchmarkGuard({
    ...options,
    stopWorkload: async () => {
      local.abort();
      await options.stopWorkload?.();
    },
  });
  let logFailure, streamTask, ticker, workFailure;
  const stream = await benchmarkLogStream({
    ...options,
    signal: session.signal,
    onEvent: event => guard.observe(event),
  });
  streamTask = stream.run().catch(error => {
    if (!session.signal.aborted) {
      logFailure = error;
      guard.monitor.fail('BENCHMARK_LOG_UNAVAILABLE');
      local.abort();
    }
  });
  const deadline = now() + 75 * 60_000;
  ticker = (async () => {
    while (!session.signal.aborted) {
      if (now() > deadline) {
        guard.monitor.fail('BENCHMARK_DEADLINE');
        local.abort();
      }
      await guard.tick();
      await pause(1000, undefined, { signal: session.signal });
    }
  })().catch(error => {
    if (!session.signal.aborted) {
      workFailure = error;
      local.abort();
    }
  });
  try {
    try {
      await workload(local.signal);
    } catch (error) {
      workFailure ??= error;
    }
    const attributionDeadline = now() + 30_000;
    while (!guard.monitor.target.projectId && !logFailure && now() < attributionDeadline) await pause(50);
    await guard.stop();
    const cleanupDeadline = now() + 15 * 60_000;
    while (!(await guard.confirmDeleted())) {
      if (now() >= cleanupDeadline) throw Error('BENCHMARK_DELETE_PENDING');
      await pause(10_000);
    }
    // No Convex function polling during the quiet proof: only provider logs and
    // a local timer. A stream error cannot turn silence into a passing result.
    while (
      !guard.monitor.quiet() ||
      stream.observedThrough < Math.max(guard.monitor.deletedAt, guard.monitor.lastExecution) + 300_000
    ) {
      if (logFailure) throw logFailure;
      if (guard.monitor.coverageFailure) throw Error(guard.monitor.coverageFailure);
      if (now() >= deadline) throw Error('BENCHMARK_QUIET_UNPROVEN');
      await pause(1000);
    }
    if (logFailure) throw logFailure;
    return { ...guard.report(), workloadFailed: Boolean(workFailure) };
  } finally {
    session.abort();
    local.abort();
    await Promise.all([streamTask, ticker]);
  }
}
