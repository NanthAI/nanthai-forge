import type { PreviewMeasurement } from './train-accounting.js';
// SPDX-License-Identifier: Apache-2.0
import { decorateRepair } from './agent-repair-lineage.js';
import { landingRepairNotices } from './landing-repair-notice.js';
import { previewAdviceCurrent } from './integration-preview-inputs.js';
import { latestHandoff } from './agent-handoff-types.js';
import { publishedOverlap } from './agent-coordination-events.js';
import { mkdirBelow } from './mkdir-below.js';
import { lstatSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { OverlapAlert } from './agent-overlap-alerts.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { workLocked } from './work-lock.js';
import { noticeChoices, type ConflictNotice } from './agent-conflict-notice.js';
import type { Lane } from './work-types.js';
import type { BriefEvent } from './agent-brief-types.js';
import type { WorkStore } from './work-store.js';
export const peerAckSchema = z.object({
  action: z.literal('peer-ack'),
  operationId: z.string().uuid().optional(),
  laneId: z.string().uuid(),
  noticeId: z.string().regex(/^[a-f0-9]{64}$/),
  choice: z.enum(noticeChoices),
  text: z.string().optional(),
});
type Handover = NonNullable<Lane['handovers']>[number] & { laneId: string; intentId: string };
type Ack = z.infer<typeof peerAckSchema> & { operationId: string };

/** Local advisory journal, separate from portable Work and disposable peers cache.
 * Immutable per-operation files and a separate lock avoid lost concurrent answers. */
export class CoordinationJournal {
  private readonly directory: string;
  constructor(private readonly store: WorkStore) {
    this.directory = join(store.directory, 'coordination');
  }
  private prepare() {
    mkdirBelow(this.store.directory, this.directory);
    invariant(
      lstatSync(this.directory).isDirectory() && !lstatSync(this.directory).isSymbolicLink(),
      'COORDINATION_UNAVAILABLE',
      'Local coordination journal is redirected.',
    );
  }
  private read<T>(name: string): T | undefined {
    try {
      if (lstatSync(this.directory).isSymbolicLink()) return;
      const path = join(this.directory, name),
        stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) return;
      return JSON.parse(readFileSync(path, 'utf8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
  private write(name: string, value: unknown) {
    const temporary = join(this.directory, `.pending-${randomUUID()}`);
    writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, join(this.directory, name));
  }
  recordPreview(measurement: PreviewMeasurement) {
    this.prepare();
    workLocked(
      join(this.directory, 'lock'),
      () => {
        const name = `preview-cost-${measurement.executionId}.json`;
        const previous = this.read<PreviewMeasurement>(name);
        invariant(
          !previous || JSON.stringify(previous) === JSON.stringify(measurement),
          'WORK_OPERATION_CHANGED',
          'Preview execution measurement changed.',
        );
        if (!previous) this.write(name, measurement);
      },
      { operation: 'local preview measurement' },
    );
  }
  record(notices: ConflictNotice[]) {
    if (!notices.length) return;
    this.prepare();
    workLocked(join(this.directory, 'lock'), () => this.recordUnlocked(notices), {
      operation: 'local conflict notices',
    });
  }
  private recordUnlocked(notices: ConflictNotice[]) {
    for (const notice of notices) {
      const name = `notice-${notice.noticeId}.json`;
      if (!this.read(name)) this.write(name, notice);
    }
  }
  recordOverlaps(notices: OverlapAlert[]) {
    if (!notices.length) return;
    this.prepare();
    workLocked(
      join(this.directory, 'lock'),
      () => {
        for (const notice of notices) {
          const name = `overlap-${notice.noticeId}.json`;
          if (!this.read(name)) this.write(name, notice);
        }
      },
      { operation: 'local overlap notices' },
    );
    publishedOverlap(this.store);
  }
  overlaps(laneId?: string): OverlapAlert[] {
    try {
      invariant(
        !lstatSync(this.directory).isSymbolicLink(),
        'COORDINATION_UNAVAILABLE',
        'Local coordination journal is redirected.',
      );
      return readdirSync(this.directory)
        .sort()
        .filter(name => /^overlap-[a-f0-9]+\.json$/.test(name))
        .flatMap(name => {
          const row = this.read<OverlapAlert>(name);
          return row && (!laneId || row.lanes.includes(laneId)) ? [row] : [];
        })
        .sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '') || a.noticeId.localeCompare(b.noticeId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
  decorate(notice: ConflictNotice, laneId: string): ConflictNotice {
    let names: string[];
    try {
      if (lstatSync(this.directory).isSymbolicLink()) return decorateRepair(this.store, notice);
      names = readdirSync(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return decorateRepair(this.store, notice);
      throw error;
    }
    const answers = names
      .filter(name => name.startsWith('ack-'))
      .flatMap(name => {
        const row = this.read<{ command: Ack; sequence: number }>(name);
        return row?.command.noticeId === notice.noticeId ? [row] : [];
      })
      .sort((a, b) => a.sequence - b.sequence);
    let order =
      this.read<ConflictNotice>(`notice-${notice.noticeId}.json`)?.proposedOrder ?? notice.proposedOrder;
    for (const { command } of answers) {
      // Swap means this participant proposes going first, independent of receipt orientation.
      if (command.choice === 'swap') order = [command.laneId, ...order.filter(id => id !== command.laneId)];
    }
    return decorateRepair(this.store, {
      ...notice,
      proposedOrder: order,
      ...(answers.length
        ? {
            decisions: answers.map(({ command: { operationId, laneId, choice, text } }) => ({
              operationId,
              laneId,
              choice,
              ...(text ? { text } : {}),
            })),
          }
        : {}),
      ...(order[0] !== laneId ? { after: order[0] } : {}),
    });
  }
  replay(command: Ack) {
    const prior = this.read<{ command: Ack; sequence: number }>(`ack-${command.operationId}.json`);
    if (!prior) return;
    invariant(
      digest(JSON.stringify(prior.command)) === digest(JSON.stringify(command)),
      'WORK_OPERATION_CHANGED',
      'This coordination operation has different inputs.',
    );
    return prior;
  }
  ack(command: Ack, notice: ConflictNotice) {
    this.prepare();
    return workLocked(
      join(this.directory, 'lock'),
      () => {
        const prior = this.replay(command);
        if (prior) return prior;
        invariant(
          notice.participants.some(p => p.lane === command.laneId),
          'BAD_ARGUMENT',
          'Lane is not a notice participant.',
        );
        this.recordUnlocked([notice]);
        const row = {
          command,
          sequence: readdirSync(this.directory).filter(name => name.startsWith('ack-')).length + 1,
        };
        this.write(`ack-${command.operationId}.json`, row);
        return row;
      },
      { operation: 'local coordination answer' },
    );
  }
  handoverReplay(operationId: string, request: string, laneId: string) {
    try {
      const directory = lstatSync(this.directory);
      invariant(
        directory.isDirectory() && !directory.isSymbolicLink(),
        'COORDINATION_UNAVAILABLE',
        'Local coordination journal is redirected.',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const row = this.read<Handover>(`handover-${operationId}.json`);
    if (row)
      invariant(
        row.request === request && row.laneId === laneId,
        'WORK_OPERATION_CHANGED',
        'This handover operation has different inputs.',
      );
    return row;
  }
  handover(row: Handover) {
    this.prepare();
    return workLocked(
      join(this.directory, 'lock'),
      () => {
        const prior = this.handoverReplay(row.operationId, row.request, row.laneId);
        if (prior) return prior;
        this.write(`handover-${row.operationId}.json`, row);
        return row;
      },
      { operation: 'local handover' },
    );
  }
  context(laneId?: string) {
    const lanes = laneId
      ? [this.store.select('lanes', laneId)].filter((lane): lane is Lane => !!lane)
      : this.store.load().lanes;
    const handoffs = lanes.flatMap(lane => {
      const handoff = latestHandoff(this.store.select('intents', lane.intentId)?.notes ?? [], lane.id);
      return handoff ? [handoff] : [];
    });
    const deliveryMessages: BriefEvent[] = handoffs.map(row => ({
      id: row.operationId,
      actor: row.actor,
      kind: 'handoff',
      text: row.summary,
      head: row.head,
      laneId: row.laneId,
      intentId: row.intentId,
      paths: [],
    }));
    let names: string[];
    try {
      invariant(
        !lstatSync(this.directory).isSymbolicLink(),
        'COORDINATION_UNAVAILABLE',
        'Local coordination journal is redirected.',
      );
      names = readdirSync(this.directory).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') names = [];
      else throw error;
    }
    const handovers = names
      .filter(name => /^handover-[a-f0-9-]+\.json$/.test(name))
      .flatMap(name => {
        const row = this.read<Handover>(name);
        return row && (!laneId || row.laneId === laneId) ? [row] : [];
      })
      .sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
    const retainedNotices = [
      ...landingRepairNotices(this.store)
        .map(row => this.decorate(row, laneId ?? ''))
        .filter(
          row =>
            !laneId ||
            row.participants.some(p => p.lane === laneId) ||
            row.resolutions?.some(r => r.laneId === laneId),
        ),
      ...names
        .filter(name => /^notice-[a-f0-9]+\.json$/.test(name))
        .flatMap(name => {
          const row = this.read<ConflictNotice>(name);
          if (!row) return [];
          const notice = this.decorate(row, laneId ?? '');
          if (
            laneId &&
            !notice.participants.some(p => p.lane === laneId) &&
            !notice.resolutions?.some(r => r.laneId === laneId)
          )
            return [];
          if (notice.integration)
            notice.integration = {
              ...notice.integration,
              applicability: previewAdviceCurrent(this.store, notice.integration, notice.noticeId)
                ? 'current'
                : 'historical',
            };
          return [decorateRepair(this.store, notice)];
        }),
    ];
    const uniqueNotices = new Map<string, ConflictNotice>();
    for (const notice of retainedNotices)
      if (!uniqueNotices.has(notice.noticeId)) uniqueNotices.set(notice.noticeId, notice);
    const notices = [...uniqueNotices.values()];
    const overlapMessages: BriefEvent[] = this.overlaps(laneId).map(row => ({
      id: row.noticeId,
      actor: 'Forge coordination',
      kind: 'message',
      text: row.text,
      ...(laneId ? { laneId } : {}),
      paths: [row.file],
    }));
    const messages: BriefEvent[] = handovers.map(row => ({
      id: row.operationId,
      actor: row.actor,
      kind: 'handoff',
      text: `${row.actor} took ownership${row.from ? ` from ${row.from}` : ''}.`,
      head: row.head,
      laneId: row.laneId,
      intentId: row.intentId,
      paths: [],
    }));
    for (const notice of notices) {
      if (
        (notice.integration || notice.evidence?.some(e => e.kind === 'check')) &&
        notice.applicability !== 'historical'
      )
        for (const participant of notice.participants.filter(p => !laneId || p.lane === laneId))
          messages.push({
            id: notice.noticeId,
            actor: notice.integration ? 'Integration preview' : 'Landing check',
            kind: 'message',
            text: notice.reason,
            head: participant.head,
            laneId: participant.lane,
            intentId: participant.intentId,
            paths: [],
          });
    }
    messages.push(...overlapMessages);
    for (const notice of notices)
      for (const decision of notice.decisions ?? []) {
        if (!decision.text) continue;
        const participant = notice.participants.find(p => p.lane === decision.laneId);
        messages.push({
          id: decision.operationId,
          actor: participant?.owner?.name ?? decision.laneId,
          kind: 'message',
          text: decision.text,
          laneId: laneId ?? decision.laneId,
          paths: notice.conflicts.map(c => c.path),
        });
      }
    return { handovers, handoffs, notices, messages: [...deliveryMessages, ...messages] };
  }
}
