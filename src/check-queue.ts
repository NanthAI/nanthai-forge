// SPDX-License-Identifier: Apache-2.0
import { mkdirBelow } from './mkdir-below.js';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { invariant, ForgeError } from './errors.js';
import { workLocked } from './work-lock.js';
import { workProgressIdentity } from './work-progress.js';
import { processesAlive, processGroupAlive, processIdentity } from './local-process.js';

const ticketSchema = z.object({
  number: z.number().int().positive().safe(),
  limit: z.number().int().positive().safe(),
  childPid: z.number().int().positive().optional(),
  childStartTime: z.string().optional(),
  released: z.boolean().optional(),
  operationId: z.string().optional(),
  actor: z.string().optional(),
  runId: z.string().optional(),
  phase: z.string().optional(),
  root: z.string().optional(),
  laneId: z.string().optional(),
  createdAt: z.number().optional(),
  priority: z.enum(['audit', 'landing']).optional(),
  control: z.boolean().optional(),
  holding: z.boolean().optional(),
});
type Ticket = z.infer<typeof ticketSchema>;
/** A filesystem bakery queue: choosing entries precede admission, ticket identities are immutable
 * and uniquely named, so two stale reapers cannot remove a replacement holder (no ABA). */
export class CheckQueue {
  readonly path: string;
  private ticket: Ticket;
  private readonly serializeAdmission;
  private control: CheckQueue | undefined;
  private controlPath: string | undefined;
  constructor(
    private readonly directory = process.env.FORGE_CHECK_QUEUE_DIR ??
      join(homedir(), '.forge', 'check-queue'),
    options: {
      serializeAdmission?: boolean;
      limit?: number;
      identity?: Partial<Ticket>;
      /** An existing directory the queue may create children under; it is never recreated. */
      anchor?: string;
    } = {},
  ) {
    this.serializeAdmission = options.serializeAdmission ?? directory === checkQueueDirectory();
    const configured = process.env.FORGE_MAX_CONCURRENT_CHECKS;
    const limit =
      options.limit ??
      (configured === undefined ? Math.max(1, Math.floor(cpus().length / 4)) : Number(configured));
    invariant(
      Number.isSafeInteger(limit) && limit >= 1,
      'BAD_ARGUMENT',
      'FORGE_MAX_CONCURRENT_CHECKS must be a positive integer.',
    );
    const identity = processIdentity();
    if (options.anchor) mkdirBelow(options.anchor, directory);
    else mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(
      directory,
      `${identity.pid}.${Buffer.from(identity.startTime).toString('base64url')}.${randomUUID()}`,
    );
    mkdirSync(this.path, { mode: 0o700 });
    try {
      const entries = this.entries();
      this.ticket = {
        number: Math.max(0, ...entries.map(item => item.ticket?.number ?? 0)) + 1,
        limit,
        createdAt: Date.now(),
        ...workProgressIdentity(),
        ...options.identity,
      };
      this.save();
      if (!this.ticket.control && this.ticket.operationId && directory === checkQueueDirectory()) {
        const control = entries.find(
          item => item.ticket?.control && item.ticket.operationId === this.ticket.operationId,
        );
        if (control) {
          this.controlPath = control.path;
          this.copyMarkers(control.path);
        }
      }
    } catch (error) {
      this.release();
      throw error;
    }
  }
  private save() {
    const temp = join(this.path, 'ticket.tmp');
    writeFileSync(temp, JSON.stringify(this.ticket), { mode: 0o600 });
    renameSync(temp, join(this.path, 'ticket.json'));
  }
  private entries() {
    return queueEntries(this.directory);
  }
  position(): {
    acquired: boolean;
    position: number;
    holder: ({ pid: number } & Partial<Ticket>) | undefined;
  } {
    if (!this.serializeAdmission) return this.calculatePosition();
    try {
      return workLocked(join(this.directory, 'admission.lock'), () => this.calculatePosition(), {
        waitMs: 0,
      });
    } catch (error) {
      if (!(error instanceof ForgeError && error.code === 'WORK_BUSY')) throw error;
      return { acquired: false, position: this.entries().length, holder: undefined };
    }
  }
  private calculatePosition() {
    if (this.control) this.copyControl(this.control);
    if (this.controlPath) this.copyMarkers(this.controlPath);
    const entries = this.entries().filter(
      item =>
        !item.ticket?.control &&
        !(
          existsSync(join(item.path, 'cancel')) &&
          !processGroupAlive(item.ticket?.childPid, item.ticket?.childStartTime)
        ),
    );
    const choosing = entries.some(item => !item.ticket);
    // Kill yielded audits before a foreground caller can claim their capacity.
    // The cancellation marker makes the runner retain a cancelled receipt.
    let preempting = false;
    if (entries.some(item => item.ticket?.priority !== 'audit')) {
      for (const item of entries.filter(item => item.ticket?.priority === 'audit')) {
        if (item.ticket?.childPid && processGroupAlive(item.ticket.childPid, item.ticket.childStartTime)) {
          cancelEntry(item);
          preempting ||= processGroupAlive(item.ticket.childPid, item.ticket.childStartTime);
        }
      }
    }
    const limit = Math.min(
      this.ticket.limit,
      ...entries.map(item => item.ticket?.limit ?? this.ticket.limit),
    );
    const ahead = entries.filter(
      item => item.ticket && compareTickets(item, { path: this.path, ticket: this.ticket }) < 0,
    );
    const first = ahead.sort(compareTickets)[0];
    const acquired = !choosing && !preempting && ahead.length < limit;
    if (acquired && !this.ticket.holding) {
      this.ticket.holding = true;
      this.save();
    }
    return {
      acquired,
      position: ahead.length + 1,
      holder: first ? { pid: first.pid, ...first.ticket } : undefined,
    };
  }
  update(identity: Partial<Ticket>) {
    Object.assign(this.ticket, identity);
    this.save();
  }
  static observe(runId: string, directory = checkQueueDirectory()) {
    try {
      const tickets = queueEntries(directory)
        .filter(item => !item.ticket?.control)
        .sort(compareTickets)
        .map(item => ({ ...item.ticket!, pid: item.pid, path: item.path }));
      const index = tickets.findIndex(ticket => ticket.runId === runId);
      return index < 0 ? undefined : { position: index + 1, holder: index > 0 ? tickets[0] : undefined };
    } catch {
      return undefined;
    }
  }
  follow(control: CheckQueue) {
    this.control = control;
  }
  private copyControl(control: CheckQueue) {
    this.copyMarkers(control.path);
  }
  private copyMarkers(path: string) {
    for (const name of ['cancel', 'priority']) {
      try {
        writeFileSync(join(this.path, name), readFileSync(join(path, name)), { mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  cancelled(): boolean {
    return (
      existsSync(join(this.path, 'cancel')) ||
      (this.controlPath !== undefined && existsSync(join(this.controlPath, 'cancel'))) ||
      (this.control?.cancelled() ?? false)
    );
  }
  tryAcquire(): boolean {
    if (this.cancelled()) return false;
    const position = this.position();
    return !this.cancelled() && position.acquired;
  }
  child(pid: number, startTime?: string) {
    this.ticket.childPid = pid;
    if (startTime) this.ticket.childStartTime = startTime;
    this.save();
  }
  release() {
    // A detached descendant still consumes capacity after its runner exits.
    if (this.ticket && processGroupAlive(this.ticket.childPid, this.ticket.childStartTime)) {
      this.ticket.released = true;
      this.save();
      return;
    }
    rmSync(this.path, { recursive: true, force: true });
  }
}

export const checkQueueDirectory = () =>
  process.env.FORGE_CHECK_QUEUE_DIR ?? join(homedir(), '.forge', 'check-queue');
export function queueHolder(holder?: {
  pid?: number | undefined;
  actor?: string | undefined;
  operationId?: string | undefined;
  runId?: string | undefined;
  phase?: string | undefined;
}) {
  if (!holder) return 'admission pending (holder details not published)';
  return `${holder.actor ?? `pid ${holder.pid}`} ${holder.operationId ? `operation=${holder.operationId} ` : ''}${holder.runId ? `run=${holder.runId} ` : ''}${holder.phase ? `phase=${holder.phase}` : ''}`.trim();
}

// Polling waiters must not fork ps on every 25ms tick. Reuse only conservative
// positive observations briefly, checking ESRCH on every scan. A cached positive
// can postpone recovery, never authorize deleting a live/reused process's ticket.
const liveObservations = new Map<string, number>();
function queueProcessesAlive(identities: { pid: number; startTime?: string | undefined }[]) {
  const now = performance.now();
  for (const [key, until] of liveObservations) if (until <= now) liveObservations.delete(key);
  const pending: number[] = [];
  const alive = identities.map((identity, index) => {
    const key = `${identity.pid}.${identity.startTime}`;
    try {
      process.kill(identity.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        liveObservations.delete(key);
        return false;
      }
    }
    if (liveObservations.has(key)) return true;
    pending.push(index);
    return true;
  });
  const sampled = processesAlive(pending.map(index => identities[index]!));
  sampled.forEach((value, offset) => {
    const index = pending[offset]!,
      identity = identities[index]!;
    alive[index] = value;
    if (value) liveObservations.set(`${identity.pid}.${identity.startTime}`, performance.now() + 250);
  });
  return alive;
}
export function queueEntries(directory = checkQueueDirectory()) {
  if (!existsSync(directory)) return [];
  const entries = readdirSync(directory).flatMap(name => {
    const match = /^(\d+)\.([\w-]+)\.([\w-]+)$/.exec(name);
    if (!match) return [];
    const path = join(directory, name);
    let ticket: Ticket | undefined;
    try {
      ticket = ticketSchema.parse(JSON.parse(readFileSync(join(path, 'ticket.json'), 'utf8')));
    } catch {
      /* Live choosing processes still precede admission. */
    }
    const identity = { pid: Number(match[1]), startTime: Buffer.from(match[2]!, 'base64url').toString() };
    return [{ path, ticket, pid: identity.pid, identity }];
  });
  const alive = queueProcessesAlive(entries.map(item => item.identity));
  return entries.flatMap(({ path, ticket, pid }, index) => {
    if ((!alive[index] || ticket?.released) && !processGroupAlive(ticket?.childPid, ticket?.childStartTime)) {
      rmSync(path, { recursive: true, force: true });
      return [];
    }
    return [{ path, ticket, pid }];
  });
}
export function compareTickets(
  a: { path: string; ticket?: Ticket | undefined },
  b: { path: string; ticket?: Ticket | undefined },
) {
  const rank = (item: typeof a) => (item.ticket?.priority === 'audit' ? 1 : 0);
  const urgent = (item: typeof a) => {
    try {
      return Number(readFileSync(join(item.path, 'priority'), 'utf8')) || 0;
    } catch {
      return 0;
    }
  };
  return (
    rank(a) - rank(b) ||
    Number(!!b.ticket?.holding) - Number(!!a.ticket?.holding) ||
    urgent(a) - urgent(b) ||
    (a.ticket?.number ?? 0) - (b.ticket?.number ?? 0) ||
    a.path.localeCompare(b.path)
  );
}
export const foregroundQueued = (directory = checkQueueDirectory()) =>
  queueEntries(directory).some(item => item.ticket && item.ticket.priority !== 'audit');
function cancelEntry(item: ReturnType<typeof queueEntries>[number]) {
  try {
    writeFileSync(join(item.path, 'cancel'), '', { mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const ticket = item.ticket!;
  if (processGroupAlive(ticket.childPid, ticket.childStartTime)) {
    try {
      process.kill(process.platform === 'win32' ? ticket.childPid! : -ticket.childPid!, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
}
export function operationTickets(operationId: string, directory = checkQueueDirectory()) {
  const entries = queueEntries(directory);
  const direct = entries.filter(
    item => item.ticket?.operationId === operationId || item.ticket?.runId === operationId,
  );
  const runs = new Set(direct.flatMap(item => (item.ticket?.runId ? [item.ticket.runId] : [])));
  return entries.filter(item => direct.includes(item) || (item.ticket?.runId && runs.has(item.ticket.runId)));
}
export function cancelTickets(operationId: string, directory = checkQueueDirectory()) {
  const entries = operationTickets(operationId, directory);
  for (const item of entries) cancelEntry(item);
  return entries.length;
}
