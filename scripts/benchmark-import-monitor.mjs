// SPDX-License-Identifier: Apache-2.0
// Provider log adapter. Retain numeric execution metadata only, never raw logs.
export const benchmarkLimits = Object.freeze({
  perMinute: 300,
  sustainedMinutes: 3,
  total: 5000,
  quietMs: 300_000,
});
export class ImportBenchmarkMonitor {
  constructor({ projectId, name, creationOperationId, since, now = Date.now }) {
    if (!projectId && !creationOperationId) throw Error('BENCHMARK_PROJECT_REQUIRED');
    this.target = { projectId, name };
    this.creationOperationId = creationOperationId;
    this.since = since;
    this.now = now;
    this.requests = new Map();
    this.seen = new Set();
    this.completed = new Set();
    this.running = new Set();
    this.minutes = new Map();
    this.total = 0;
    this.failures = 0;
    this.postDelete = 0;
    this.lastExecution = since;
    this.reason = null;
    this.coverageFailure = null;
    this.deletedAt = null;
    this.usage = { databaseReadDocuments: 0, databaseWriteDocuments: 0 };
  }
  fail(code) {
    this.reason ??= code;
    if (code.startsWith('BENCHMARK_LOG_')) this.coverageFailure ??= code;
  }
  accept(event) {
    if (
      (!this.completed.has(event.id) && this.completed.size >= 20_000) ||
      (!this.running.has(event.id) && this.running.size >= 20_000)
    ) {
      this.fail('BENCHMARK_LOG_CAPACITY');
      return;
    }
    if (event.completed) {
      this.completed.add(event.id);
      this.running.delete(event.id);
    } else if (!this.completed.has(event.id)) this.running.add(event.id);
    if (event.parent && !this.completed.has(event.parent)) this.running.add(event.parent);
    if (event.counted) this.count(event);
  }
  count(event) {
    if (event.at < this.since) return;
    this.total++;
    this.failures += event.failed ? 1 : 0;
    this.lastExecution = Math.max(this.lastExecution, event.at);
    if (this.deletedAt !== null && event.at >= this.deletedAt) this.postDelete++;
    const minute = Math.floor((event.at - this.since) / 60_000);
    this.minutes.set(minute, (this.minutes.get(minute) ?? 0) + 1);
    for (const key of Object.keys(this.usage)) this.usage[key] += event.usage?.[key] ?? 0;
    if (this.total >= benchmarkLimits.total) this.fail('total');
    this.advance(this.now());
  }
  observe(log) {
    if (!['Progress', 'Completion'].includes(log.kind)) return;
    if (
      typeof log.requestId !== 'string' ||
      typeof log.executionId !== 'string' ||
      !Number.isFinite(log.timestamp)
    ) {
      this.fail('BENCHMARK_LOG_SCHEMA');
      return;
    }
    let request = this.requests.get(log.requestId);
    if (!request) {
      if (this.requests.size >= 20_000) {
        this.fail('BENCHMARK_LOG_CAPACITY');
        return;
      }
      this.requests.set(log.requestId, (request = { own: null, pending: [] }));
    }
    for (const line of log.logLines ?? []) {
      const text = typeof line === 'string' ? line : (line.messages ?? []).join(' ');
      const marker = text.match(/FORGE_PROJECT_EXECUTION (\{.*\})/);
      if (!marker) continue;
      let target;
      try {
        target = JSON.parse(marker[1]);
      } catch {
        this.fail('BENCHMARK_LOG_SCHEMA');
        continue;
      }
      if (
        !this.target.projectId &&
        target.key === this.creationOperationId &&
        target.name === this.target.name
      )
        this.target.projectId = target.projectId;
      if (target.projectId !== this.target.projectId) continue;
      if (target.name !== null && target.name !== this.target.name) this.fail('BENCHMARK_PROJECT_CHANGED');
      request.own = true;
      for (const event of request.pending) this.accept(event);
      request.pending = [];
    }
    if (log.kind !== 'Completion') {
      if (request.own) this.accept({ id: log.executionId, completed: false });
      return;
    }
    // OCC retries and failed executions count. Replayed transport records do not.
    const key = `${log.requestId}:${log.executionId}:${log.executionTimestamp ?? log.timestamp}:${log.timestamp}:${log.occInfo?.retryCount ?? 0}`;
    if (this.seen.has(key)) return;
    if (this.seen.size >= 20_000) {
      this.fail('BENCHMARK_LOG_CAPACITY');
      return;
    }
    this.seen.add(key);
    const event = {
      id: log.executionId,
      parent: log.parentExecutionId,
      completed: true,
      counted: true,
      at: log.timestamp * 1000,
      failed: Boolean(log.error),
      usage: log.usageStats,
    };
    if (request.own) this.accept(event);
    else request.pending.push(event);
  }
  advance(at) {
    const closed = Math.floor((at - this.since) / 60_000) - 1;
    for (const minute of this.minutes.keys()) {
      if (minute > closed) continue;
      if ([0, 1, 2].every(offset => (this.minutes.get(minute - offset) ?? 0) > benchmarkLimits.perMinute))
        this.fail('rate');
    }
  }
  deleted(at = this.now()) {
    this.deletedAt = at;
  }
  quiet(at = this.now()) {
    return (
      !this.coverageFailure &&
      this.running.size === 0 &&
      this.deletedAt !== null &&
      at - Math.max(this.deletedAt, this.lastExecution) >= benchmarkLimits.quietMs
    );
  }
  report() {
    return {
      ...this.target,
      total: this.total,
      failures: this.failures,
      reason: this.reason,
      coverageFailure: this.coverageFailure,
      postDelete: this.postDelete,
      usage: { ...this.usage },
      quiet: this.quiet(),
      retainedExecutions: this.seen.size,
      runningExecutions: this.running.size,
    };
  }
}
