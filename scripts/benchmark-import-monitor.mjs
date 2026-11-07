// SPDX-License-Identifier: Apache-2.0
// Provider log adapter. Retain numeric execution metadata only, never raw logs.
export const benchmarkLimits = Object.freeze({
  perMinute: 300,
  sustainedMinutes: 3,
  total: 5000,
  quietMs: 300_000,
});
// A failed execution is classified by its ForgeError code only (an uppercase token such as WORK_STALE),
// so a capture can say why executions failed. The error text itself is never retained.
export function failureCode(error) {
  const code = /["']?code["']?\s*[:=]\s*["']([A-Z][A-Z0-9_]{2,47})["']/.exec(String(error ?? ''))?.[1];
  return code ?? 'UNCODED';
}
// Only numeric provider metadata enters the meter. An absent/invalid value is
// unknown, not a free execution. Field names are fixed; no raw log data is retained.
export function completionUsage(log, keys) {
  const missingFields = [];
  const number = (value, field) => {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
    missingFields.push(field);
    return null;
  };
  const usage = Object.fromEntries(
    keys.map(key => [key, number(log.usageStats?.[key], `usageStats.${key}`)]),
  );
  let gbHours = 0;
  if (/^(?:Http)?Action$/i.test(log.udfType ?? '')) {
    const memory = number(
      log.usageStats?.memoryUsedMb ?? log.usageStats?.actionMemoryUsedMb,
      'usageStats.memoryUsedMb|actionMemoryUsedMb',
    );
    // Completion executionTime is seconds; older adapters expose milliseconds.
    const seconds =
      log.executionTime != null
        ? number(log.executionTime, 'executionTime')
        : number(log.executionTimeMs, 'executionTime|executionTimeMs');
    const hours = seconds === null ? null : seconds / (log.executionTime != null ? 3600 : 3_600_000);
    gbHours = memory === null || hours === null ? null : (memory / 1024) * hours;
  } else if (!/^(?:Query|Mutation)$/i.test(log.udfType ?? '')) {
    missingFields.push('udfType');
    gbHours = null;
  }
  return { usage, gbHours, missingFields };
}

export class ImportBenchmarkMonitor {
  constructor({ projectId, name, creationOperationId, since, now = Date.now, capacity = 20_000 }) {
    if (!projectId && !creationOperationId) throw Error('BENCHMARK_PROJECT_REQUIRED');
    this.target = { projectId, name };
    this.creationOperationId = creationOperationId;
    this.since = since;
    this.now = now;
    this.capacity = capacity;
    this.actionGbHours = 0;
    this.missingUsageFields = {};
    this.functions = new Map();
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
      (!this.completed.has(event.id) && this.completed.size >= this.capacity) ||
      (!this.running.has(event.id) && this.running.size >= this.capacity)
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
    const identifier = event.identifier ?? '(unknown function)';
    const key = JSON.stringify([identifier, event.udfType]);
    let fn = this.functions.get(key);
    if (!fn) {
      fn = {
        identifier,
        udfType: event.udfType,
        executions: 0,
        cachedExecutions: 0,
        failures: 0,
        failureCodes: {},
        usage: Object.fromEntries(Object.keys(this.usage).map(key => [key, 0])),
        actionGbHours: 0,
        missingUsageFields: {},
      };
      this.functions.set(key, fn);
    }
    fn.executions++;
    fn.cachedExecutions += event.cached ? 1 : 0;
    fn.failures += event.failed ? 1 : 0;
    if (event.failed) fn.failureCodes[event.failureCode] = (fn.failureCodes[event.failureCode] ?? 0) + 1;
    for (const field of [...event.missingFields, ...(event.identifier ? [] : ['identifier'])])
      fn.missingUsageFields[field] = (fn.missingUsageFields[field] ?? 0) + 1;
    for (const field of Object.keys(this.usage))
      fn.usage[field] =
        fn.usage[field] === null || event.usage[field] === null ? null : fn.usage[field] + event.usage[field];
    fn.actionGbHours =
      fn.actionGbHours === null || event.gbHours === null ? null : fn.actionGbHours + event.gbHours;
    this.total++;
    this.failures += event.failed ? 1 : 0;
    this.lastExecution = Math.max(this.lastExecution, event.at);
    if (this.deletedAt !== null && event.at >= this.deletedAt) this.postDelete++;
    const minute = Math.floor((event.at - this.since) / 60_000);
    this.minutes.set(minute, (this.minutes.get(minute) ?? 0) + 1);
    for (const field of event.missingFields)
      this.missingUsageFields[field] = (this.missingUsageFields[field] ?? 0) + 1;
    for (const key of Object.keys(this.usage))
      this.usage[key] =
        this.usage[key] === null || event.usage[key] === null ? null : this.usage[key] + event.usage[key];
    this.actionGbHours =
      this.actionGbHours === null || event.gbHours === null ? null : this.actionGbHours + event.gbHours;
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
      if (this.requests.size >= this.capacity) {
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
    if (this.seen.size >= this.capacity) {
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
      failureCode: log.error ? failureCode(log.error) : null,
      identifier: typeof log.identifier === 'string' && log.identifier.length ? log.identifier : null,
      udfType: typeof log.udfType === 'string' ? log.udfType : null,
      cached: log.cachedResult === true,
      ...completionUsage(log, Object.keys(this.usage)),
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
      actionGbHours: this.actionGbHours,
      missingUsageFields: { ...this.missingUsageFields },
      perFunction: [...this.functions.values()].map(fn => ({
        ...fn,
        failureCodes: { ...fn.failureCodes },
        usage: { ...fn.usage },
        missingUsageFields: { ...fn.missingUsageFields },
      })),
      quiet: this.quiet(),
      retainedExecutions: this.seen.size,
      runningExecutions: this.running.size,
    };
  }
}
