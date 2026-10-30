// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initNative } from './native-work.js';
import { NativeSource } from './native-source.js';
import { WorkService } from './work.js';
import { checkEnvironment } from './check-environment.js';
import { finishChild } from './agent-finish-journal.js';
import { selectBatch } from './landing-batch-store.js';
import { policyPreset, editedPolicy } from './autonomy-policy.js';
import type { ReplayWorkload } from './landing-replay.js';
import type { LandingBatch } from './landing-batch-types.js';

export const replayStamp = (ms: number) => new Date(Date.UTC(2026, 0, 1) + ms).toISOString();
const seed = '76cf3468-0123-4567-89ab-000000000001';
/** Disposable synthetic source plus the production selector/overlap planner.
 * No dispatch, worker, credentials or real provider is constructed or invoked. */
export class ReplayPlanner {
  readonly root = mkdtempSync(join(tmpdir(), 'forge-train-replay-'));
  private readonly work;
  private readonly source;
  readonly data;
  private readonly labels = new Map<string, string>();
  constructor(
    workload: ReplayWorkload,
    private readonly mode: 'serial' | 'train',
  ) {
    writeFileSync(join(this.root, 'paragraph.txt'), 'one\ntwo\nthree\nfour\n');
    initNative(this.root);
    this.work = new WorkService(this.root);
    this.source = new NativeSource(this.root);
    this.data = this.work.store.load();
    const environment = checkEnvironment(),
      base = this.data.nativeHead!;
    const check = {
      id: finishChild(seed, 'check'),
      name: 'synthetic',
      executable: 'synthetic-no-execution',
      args: [],
      environmentLabel: 'synthetic',
      definition: 'a'.repeat(64),
      at: replayStamp(0),
    };
    this.data.checks = [check];
    this.data.landingEntries = [];
    this.data.landingBatches = [];
    this.data.autonomyPolicy = editedPolicy(policyPreset('trusted'), {
      action: 'set-policy',
      operationId: finishChild(seed, 'policy'),
      checks: { runner: 'github-actions', runsOn: 'blacksmith-4vcpu-ubuntu-2404', concurrency: 4 },
    });
    for (const [index, row] of workload.arrivals.entries()) {
      const id = finishChild(seed, `${workload.name}:${row.id}`),
        viewId = finishChild(id, 'view'),
        intentId = finishChild(id, 'intent');
      this.labels.set(id, row.id);
      const files = [...this.source.state(base).files];
      if (row.overlap) {
        const lines = ['one', 'two', 'three', 'four'];
        lines[row.conflict ? 0 : index % 4] = row.id;
        files[0] = { ...files[0]!, blob: this.source.put(Buffer.from(lines.join('\n') + '\n')) };
      } else files.push({ path: `${row.id}.txt`, mode: 'file', blob: this.source.put(Buffer.from(row.id)) });
      const head = this.source.writeState(files, [base], row.id, replayStamp(0));
      this.data.lanes.push({
        id,
        intentId,
        name: row.id,
        base,
        head,
        assignment: '',
        target: '',
        state: 'active',
        startedAt: replayStamp(index),
        checkpoints: [],
      });
      this.data.views.push({
        id: viewId,
        intentId,
        base,
        head,
        status: 'clean',
        inputs: [{ laneId: id, head }],
        dependencies: [],
        at: replayStamp(row.atMs),
        details: 'Synthetic replay input',
      });
      this.data.landingEntries.push({
        id,
        request: 'a'.repeat(64),
        channel: 'main',
        viewId,
        head,
        checkId: check.id,
        definition: check.definition,
        environment: environment.fingerprint,
        environmentSnapshot: environment,
        arrivedAt: replayStamp(row.atMs),
        priority: 'normal',
        submitter: row.id,
        keepOpen: false,
        status: 'queued',
      });
    }
    // The production selector reads configured shape from this synthetic owner's policy.
    this.work.store.locked(() => this.work.store.save(this.data));
  }
  private main() {
    return this.data.channelMoves.at(-1)?.head ?? null;
  }
  take(now: number, started: Set<string>) {
    let entries = this.data.landingEntries!.filter(
      entry => Date.parse(entry.arrivedAt) <= Date.parse(replayStamp(now)),
    );
    if (this.mode === 'serial') {
      const first = entries.find(entry => entry.status === 'queued');
      entries = entries.filter(entry => entry.status !== 'queued' || entry === first);
    }
    const batch = selectBatch(this.work, { ...this.data, landingEntries: entries }, 'main', started);
    if (!batch) return undefined;
    const conflicts: string[] = [];
    let head = batch.base;
    for (const id of batch.entryIds) {
      const entry = this.data.landingEntries!.find(row => row.id === id)!;
      const composed = this.source.compose(
        head,
        entry.head,
        'Synthetic replay composition',
        replayStamp(now),
      );
      if (!composed.head) {
        entry.status = 'conflict';
        conflicts.push(this.labels.get(id)!);
        continue;
      }
      head = composed.head;
      batch.prefixes.push({
        entryIds: [...(batch.prefixes.at(-1)?.entryIds ?? []), id],
        viewId: finishChild(batch.id, `prefix:${id}`),
        runId: finishChild(batch.id, `run:${id}`),
        head,
      });
    }
    batch.status = 'checking';
    const ids = batch.prefixes.at(-1)?.entryIds.map(id => this.labels.get(id)!) ?? [];
    return { batch, ids, conflicts };
  }
  current(batch: LandingBatch) {
    return this.main() === batch.previous;
  }
  finish(
    batch: LandingBatch,
    passing: string[],
    failed: string | undefined,
    stopped: string | undefined,
    now: number,
  ) {
    batch.status = 'completed';
    const prefix = batch.prefixes.find(
      prefix => prefix.entryIds.map(id => this.labels.get(id)!).join(',') === passing.join(','),
    );
    if (prefix)
      this.data.channelMoves.push({
        id: finishChild(batch.id, 'accepted'),
        channel: 'main',
        viewId: prefix.viewId,
        head: prefix.head,
        previous: this.main(),
        at: replayStamp(now),
        status: 'accepted',
        provenance: 'user-declared-local',
      });
    for (const id of batch.entryIds) {
      const entry = this.data.landingEntries!.find(row => row.id === id)!,
        label = this.labels.get(id)!;
      if (entry.status === 'conflict') continue;
      entry.status = passing.includes(label)
        ? 'accepted'
        : label === failed
          ? 'failed'
          : stopped
            ? 'cancelled'
            : 'queued';
    }
  }
  invalidate(batch: LandingBatch) {
    batch.status = 'superseded';
    for (const entry of this.data.landingEntries!)
      if (entry.batchId === batch.id && entry.status === 'checking') entry.status = 'queued';
  }
  externalMain(now: number) {
    const base = this.main() ?? this.data.nativeHead!,
      files = [
        ...this.source.state(base).files,
        {
          path: 'external.txt',
          mode: 'file' as const,
          blob: this.source.put(Buffer.from('synthetic main change')),
        },
      ];
    const head = this.source.writeState(files, [base], 'Synthetic main race', replayStamp(now));
    this.data.channelMoves.push({
      id: finishChild(seed, 'external'),
      channel: 'main',
      viewId: finishChild(seed, 'external-view'),
      head,
      previous: this.main(),
      at: replayStamp(now),
      status: 'accepted',
      provenance: 'user-declared-local',
    });
  }
  dispose() {
    rmSync(this.root, { recursive: true, force: true });
  }
}
