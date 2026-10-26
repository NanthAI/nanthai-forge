// SPDX-License-Identifier: Apache-2.0
import { statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ForgeError } from './errors.js';
import { saveMainAuditState } from './post-accept-state.js';
import type { WorkStore } from './work-store.js';
import type { WorkData } from './work-types.js';

/** Unrelated owner commits are not audit progress. Provider observations and
 * command output keep a genuinely running audit alive, even without Work edits. */
export class MainAuditWatchdog {
  private key?: string;
  private lastProgress = Date.now();
  private runs: WorkData['runs'] = [];
  constructor(
    private store: WorkStore,
    private stallMs: number,
  ) {}
  update(data: WorkData) {
    const key = JSON.stringify([
      data.channelMoves.map(move => [
        move.id,
        move.head,
        move.postAcceptRunId,
        move.postAcceptAuditRunId,
        move.optimisticRecovery,
      ]),
      data.runs.map(run => [run.id, run.status, run.endedAt, run.cancelRequested]),
      data.intents.map(intent => intent.id),
    ]);
    this.runs = data.runs.filter(run => (run.mainCheck || run.recovery) && !run.endedAt);
    if (key !== this.key) {
      this.key = key;
      this.lastProgress = Date.now();
    }
    this.updateRuns();
  }
  private evidence = '';
  private files = new Map<string, { stamp: string; value: unknown }>();
  updateRuns() {
    const tx = this.store.readRecords?.();
    if (tx) {
      try {
        this.runs = ['queued', 'preparing', 'running']
          .flatMap(status => tx.all('runs', status, 'status'))
          .filter(run => run.mainCheck || run.recovery);
      } finally {
        tx.dispose();
      }
    }
    const evidence = JSON.stringify(
      this.runs.map(run => [
        run.id,
        ...['result.json', 'github-actions.json', 'stdout.log', 'stderr.log', 'modal-shard-logs.json'].map(
          file => {
            const path = join(this.store.directory, `check-${run.id}`, file);
            // Actions stdout/stderr contain controller diagnostics, not remote
            // command output. Its journal carries actual job/log progress.
            if (run.backend?.actual === 'github-actions' && ['stdout.log', 'stderr.log'].includes(file))
              return null;
            try {
              const info = statSync(path),
                stamp = `${info.ino}:${info.size}:${info.mtimeMs}`;
              if (file !== 'github-actions.json') return stamp;
              const retained = this.files.get(path);
              if (retained?.stamp === stamp) return retained.value;
              const journal = JSON.parse(readFileSync(path, 'utf8'));
              // Repeated failed HTTP requests or unchanged polls are not progress.
              const value = [
                journal.commit,
                journal.pushed,
                journal.runId,
                journal.states,
                journal.retrying,
                journal.logged,
                journal.terminal,
              ];
              this.files.set(path, { stamp, value });
              return value;
            } catch {
              return null;
            }
          },
        ),
      ]),
    );
    if (evidence !== this.evidence) {
      this.evidence = evidence;
      this.lastProgress = Date.now();
    }
    this.assertProgress();
    this.save('running');
  }
  assertProgress() {
    if (Date.now() - this.lastProgress < this.stallMs) return;
    this.save('stalled', 'MAIN_AUDIT_STALLED');
    throw new ForgeError(
      'MAIN_AUDIT_STALLED',
      'Main audit made no progress within its driver deadline. Accepted source, pending audit and check evidence are retained; a later wake or retry resumes observation.',
    );
  }
  waiting(code?: string, backoff?: number) {
    this.save('waiting', code, backoff);
  }
  idle() {
    this.save('idle');
  }
  private save(status: 'running' | 'waiting' | 'stalled' | 'idle', code?: string, backoff?: number) {
    saveMainAuditState(this.store, {
      status,
      lastProgressAt: new Date(this.lastProgress).toISOString(),
      runIds: this.runs.map(run => run.id),
      ...(code ? { code } : {}),
      ...(backoff ? { retryAt: new Date(Date.now() + backoff).toISOString() } : {}),
    });
  }
}
