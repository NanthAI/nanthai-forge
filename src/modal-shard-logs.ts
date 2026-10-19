// SPDX-License-Identifier: Apache-2.0
import { mkdirBelow } from './mkdir-below.js';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { durableReplace } from './native-durability.js';
import type { ModalEvent } from './modal-client.js';

type Execution = { executionId: string; index: number; attempt: number; exitCode?: number };
export function shardLogName(shard: number | 'static', attempt = 1) {
  return `${shard}${attempt > 1 ? `.attempt-${attempt}` : ''}.log`;
}

/** Execution identity survives controller adoption; retries never overwrite earlier output. */
export class ModalShardLogs {
  private executions: Execution[] = [];
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
      shardLogName(execution.index === this.staticIndex ? 'static' : execution.index, execution.attempt + 1),
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
    if (execution) appendFileSync(join(this.path, this.filename(execution)), text, { mode: 0o600 });
  }
  failureSummary(result: Extract<ModalEvent, { kind: 'result' }>) {
    for (const outcome of result.executions ?? []) {
      const execution = this.executions.find(item => item.executionId === outcome.executionId);
      if (!execution || execution.index !== outcome.index || execution.attempt !== outcome.attempt)
        throw new Error('Modal result shard identity changed.');
      if (outcome.exitCode !== undefined) execution.exitCode = outcome.exitCode;
    }
    durableReplace(this.indexPath, JSON.stringify(this.executions));
    const latest = new Map<number, Execution>();
    for (const execution of this.executions) {
      if ((latest.get(execution.index)?.attempt ?? -1) < execution.attempt)
        latest.set(execution.index, execution);
    }
    const summaries: string[] = [];
    for (const execution of latest.values()) {
      const filename = this.filename(execution);
      const lines = readFileSync(join(this.path, filename), 'utf8').split('\n');
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
      if (execution.exitCode === 0 || (!failures.length && execution.exitCode === undefined)) continue;
      summaries.push(
        `Shard ${execution.index}${execution.index === this.staticIndex ? ' (static)' : ''}, attempt ${execution.attempt + 1}${execution.exitCode === undefined ? '' : `, exit ${execution.exitCode}`}: ${basename(this.path)}/${filename}\n${
          failures.join('\n') ||
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
