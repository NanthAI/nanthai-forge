import { CompactCheckWriter } from './check-compact-output.js';
// SPDX-License-Identifier: Apache-2.0
import { mkdirBelow } from './mkdir-below.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { durableReplace } from './native-durability.js';
import type { ModalEvent } from './modal-client.js';
import { failedTestFiles } from './check-failure-files.js';

type Execution = NonNullable<Extract<ModalEvent, { kind: 'result' }>['executions']>[number];
export function shardLogName(shard: number | 'static', attempt = 1) {
  return `${shard}${attempt > 1 ? `.attempt-${attempt}` : ''}.log`;
}

/** Execution identity survives controller adoption; retries never overwrite earlier output. */
export class ModalShardLogs {
  private executions: Execution[] = [];
  private writers = new Map<string, CompactCheckWriter>();
  private readonly indexPath: string;
  constructor(
    private readonly path: string,
    private readonly staticIndex: number,
  ) {
    this.indexPath = join(path, 'modal-shard-logs.json');
    try {
      this.executions = JSON.parse(readFileSync(this.indexPath, 'utf8'));
    } catch {
      // First observation. Older bridges retain combined logs without inventing shard identity.
    }
  }
  private filename(execution: Execution) {
    return join(
      'shards',
      shardLogName(
        execution.index === this.staticIndex ? 'static' : execution.index,
        execution.attempt + 1,
      ).replace(/\.log$/, '.evidence'),
    );
  }
  register(event: Extract<ModalEvent, { kind: 'execution' }>) {
    if (event.index === undefined) return;
    if (event.index > this.staticIndex) throw new Error('Modal execution names an unselected shard.');
    const execution = { executionId: event.executionId, index: event.index, attempt: event.attempt ?? 0 };
    const previous = this.executions.find(item => item.executionId === event.executionId);
    if (previous) {
      if (previous.index !== execution.index || previous.attempt !== execution.attempt)
        throw new Error('Retained execution shard identity changed.');
      return;
    }
    if (this.executions.some(item => item.index === execution.index && item.attempt === execution.attempt))
      throw new Error('Shard attempt already belongs to another execution.');
    mkdirBelow(this.path, join(this.path, 'shards'));
    writeFileSync(join(this.path, this.filename(execution)), '', { flag: 'a', mode: 0o600 });
    this.executions.push(execution);
    durableReplace(this.indexPath, JSON.stringify(this.executions));
  }
  append(executionId: string, text: string) {
    const execution = this.executions.find(item => item.executionId === executionId);
    if (!execution) return;
    let writer = this.writers.get(executionId);
    if (!writer) {
      writer = new CompactCheckWriter(join(this.path, this.filename(execution)));
      this.writers.set(executionId, writer);
    }
    writer.append(text);
  }
  complete(executionId: string, failed: boolean) {
    this.writers.get(executionId)?.finish(failed);
  }
  failureSummary(result: Extract<ModalEvent, { kind: 'result' }>) {
    for (const outcome of result.executions ?? []) {
      const execution = this.executions.find(item => item.executionId === outcome.executionId);
      if (!execution || execution.index !== outcome.index || execution.attempt !== outcome.attempt)
        throw new Error('Modal result shard identity changed.');
      if (outcome.exitCode !== undefined) execution.exitCode = outcome.exitCode;
      if (outcome.exitCode !== undefined) {
        let writer = this.writers.get(outcome.executionId);
        if (!writer) writer = new CompactCheckWriter(join(this.path, this.filename(execution)));
        writer.finish(outcome.exitCode !== 0);
      }
      if (outcome.tests) execution.tests = outcome.tests;
      if (outcome.infrastructure) execution.infrastructure = outcome.infrastructure;
    }
    durableReplace(this.indexPath, JSON.stringify(this.executions));
    const latest = new Map<number, Execution>();
    for (const execution of this.executions) {
      if ((latest.get(execution.index)?.attempt ?? -1) < execution.attempt)
        latest.set(execution.index, execution);
    }
    const recovered = new Set(
      [...latest.values()]
        .filter(
          execution =>
            execution.exitCode === 0 &&
            this.executions.some(
              previous =>
                previous.index === execution.index &&
                previous.attempt < execution.attempt &&
                Object.values(previous.tests ?? {}).some(report => report.results.some(test => !test.passed)),
            ),
        )
        .map(execution => execution.index),
    );
    const summaries: string[] = [];
    for (const execution of this.executions.filter(
      item => latest.get(item.index) === item || recovered.has(item.index),
    )) {
      const filename = this.filename(execution);
      let text = '';
      try {
        text = readFileSync(join(this.path, filename), 'utf8');
      } catch {
        /* Legacy execution may have no compact excerpt. */
      }
      const lines = text.split('\n');
      const failedFiles = [
        ...new Set([
          ...failedTestFiles(lines.join('\n')),
          ...Object.values(execution.tests ?? {})
            .filter(report => report.results.some(test => !test.passed))
            .map(report => report.file),
        ]),
      ];
      const failures: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (!/^\s*not ok(?:\s|$)/.test(lines[i]!)) continue;
        const block = [lines[i]!.trimStart()];
        for (let j = i + 1; j < Math.min(lines.length, i + 13); j++) {
          const line = lines[j]!;
          if (/^\s*(?:ok|not ok|# Subtest:|\.\.\.)/.test(line)) break;
          if (line.trim()) block.push(line);
        }
        failures.push(block.join('\n'));
      }
      if (
        (execution.exitCode === 0 && !recovered.has(execution.index)) ||
        (!failures.length && execution.exitCode === undefined)
      )
        continue;
      const namedResults = Object.values(execution.tests ?? {})
        .flatMap(report =>
          report.results.map(test => `${test.passed ? 'passed' : 'failed'}: ${report.file} :: ${test.name}`),
        )
        .join('\n');
      summaries.push(
        `Shard ${execution.index}${execution.index === this.staticIndex ? ' (static)' : ''}, attempt ${execution.attempt + 1}${execution.exitCode === undefined ? '' : execution.exitCode === 137 ? ', exit 137/SIGKILL (likely OOM)' : `, exit ${execution.exitCode}`}: ${basename(this.path)}/${filename}\n${failedFiles.length ? `Failing tests: ${failedFiles.join(', ')}\n` : ''}${
          failures.join('\n') ||
          namedResults ||
          lines
            .filter(line => line.trim())
            .slice(-12)
            .join('\n')
        }`,
      );
    }
    const text = summaries.join('\n');
    return text.length > 4096 ? `${text.slice(0, 4095)}…` : text;
  }
}
