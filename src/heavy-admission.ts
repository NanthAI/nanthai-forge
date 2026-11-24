// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item ff33e9a6: heavy admits by measured CPU, load and memory, not only a fixed count of slots. The
// base slots (localHeavySlots) admit as before while RAM leaves headroom; extra "burst" slots open
// one at a time while the machine has CPU and memory room, so a long one-core holder (a model check)
// no longer blocks test runs at low load.
// Admission also accounts for resident memory outside heavy's own slots (untracked tsc, node test
// shards, Playwright browsers, concurrent agents) and macOS kernel memory pressure (friction
// 2475b276), scaling base and burst slots down before the machine hits out-of-application-memory.
// Load gates only the extra slots, so a busy shared runner (load past 2 x cores through a whole
// suite) keeps its base slots while memory fits.
// Local reads only: loadavg, one memory read and at most one `ps` (pids, CPU and RSS only, never
// arguments or environment) per decision.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { freemem, loadavg, totalmem } from 'node:os';
import { testWorkersPerSlot, treeCpu } from './heavy-hold.js';

/** Resident memory snapshot split between heavy's own slot trees and everything else on the host. */
type HeavyMemoryUse = {
  totalBytes: number;
  /** Resident bytes of processes outside every heavy holder's process tree. */
  outsideBytes: number;
  /** Resident bytes for each holder pid's process tree; null/absent when unmeasured. */
  holders: Record<number, number | null>;
};

/** What one admission decision reads. `cpu(pid)`: cores the pid's process tree uses now (null when
 * unknown). `memoryUse(pids)`: resident memory outside those holder trees and inside them. Both
 * share at most one `ps` per sample (pids, CPU and RSS only). */
export type HeavySample = {
  load: number | null;
  /** Free share of RAM, 0..1 (macOS: the kernel's free percentage, as `memory_pressure` reports). */
  freeRatio: number | null;
  /** Used share of swap, 0..1; null where swap grows on demand (macOS) or there is none. */
  swapUsedRatio: number | null;
  /** Kernel memory pressure level (macOS kern.memorystatus_vm_pressure_level: 1 normal, 2 warn,
   * 4 critical); null/undefined elsewhere. */
  pressure?: number | null;
  cpu(pid: number): number | null;
  memoryUse?(holderPids: number[]): HeavyMemoryUse | null;
};
export type HeavyHolderUse = {
  pid: number;
  elapsedMs: number;
  /** Cores the holder declared (nforge heavy --cores N), if any. */
  declared: number | null;
};
export type HeavyDecision = { admit: boolean; burst: boolean; reason: string | null };

/** Holders younger than this count their full share: `ps` CPU and RSS lag a starting command. */
export const HEAVY_SETTLE_MS = 30_000;
/** Freeze guard: no admission while anyone holds a slot and free memory is under this. */
export const FREEZE_FREE_RATIO = 0.1;
/** An extra slot needs about one slot's memory free (heavySlots assumes ~5 GiB a slot on 16 GiB). */
export const BURST_FREE_RATIO = 0.25;
export const BURST_SWAP_RATIO = 0.5;
/** Working-set memory reserved per young holder or newcomer (2 GiB, capped at 25% of total RAM). */
export const SLOT_MEMORY_BYTES = 2 * 2 ** 30;
/** macOS kern.memorystatus_vm_pressure_level: 1 normal, 2 warning, 4 critical. */
export const MACOS_PRESSURE_WARN = 2;
/** Most holders at once: twice the base slots, never more than the cores. */
export const heavyBurstLimit = (base: number, cores: number) =>
  Math.max(base, Math.min(Math.max(1, cores), 2 * base));

const round = (value: number) => Math.round(value * 10) / 10;
const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;
/** Cores a holder counts: a young or unmeasured holder its full share (or its declared cores),
 * a settled one what it uses now, at least one core. */
export function holderWeight(holder: HeavyHolderUse, share: number, cpu: number | null) {
  if (holder.elapsedMs < HEAVY_SETTLE_MS || cpu === null) return Math.max(holder.declared ?? share, cpu ?? 0);
  return Math.max(1, cpu);
}

/** Resident memory split between heavy's own slot trees and outside processes, from one
 * `ps -A -o pid=,ppid=,pcpu=,rss=` output (rss in KiB; never reads arguments or environment). */
export function parseProcessMemory(
  psOutput: string,
  holderPids: number[],
  totalBytes = totalmem(),
): HeavyMemoryUse {
  const children = new Map<number, number[]>();
  const rssBytes = new Map<number, number>();
  for (const line of psOutput.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const rssKb = Number(parts[3]);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(rssKb) || rssKb < 0) continue;
    rssBytes.set(pid, rssKb * 1024);
    const list = children.get(ppid);
    if (list) list.push(pid);
    else children.set(ppid, [pid]);
  }
  const inSlots = new Set<number>();
  const holders: Record<number, number | null> = {};
  for (const root of holderPids) {
    if (root <= 1) continue;
    if (!rssBytes.has(root)) {
      holders[root] = null;
      continue;
    }
    let total = 0;
    for (const queue = [root], seen = new Set<number>(); queue.length;) {
      const pid = queue.pop()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      inSlots.add(pid);
      total += rssBytes.get(pid) ?? 0;
      const kids = children.get(pid);
      if (kids) queue.push(...kids);
    }
    holders[root] = total;
  }
  let outsideBytes = 0;
  for (const [pid, bytes] of rssBytes) if (!inSlots.has(pid)) outsideBytes += bytes;
  return { totalBytes, outsideBytes, holders };
}

function projectMemory(
  holders: HeavyHolderUse[],
  sample: HeavySample,
): { outsideRatio: number; projectedRatio: number } | null {
  const mem = sample.memoryUse?.(holders.map(holder => holder.pid)) ?? null;
  if (!mem || !(mem.totalBytes > 0)) return null;
  const reserve = Math.min(SLOT_MEMORY_BYTES, mem.totalBytes * 0.25);
  let holdersActual = 0;
  let holdersProjected = 0;
  for (const holder of holders) {
    const rss = holder.pid > 1 ? (mem.holders[holder.pid] ?? null) : null;
    if (rss !== null && rss > 0) holdersActual += rss;
    holdersProjected +=
      holder.elapsedMs < HEAVY_SETTLE_MS || rss === null ? Math.max(rss ?? 0, reserve) : Math.max(0, rss);
  }
  const outsidePsRatio = Math.max(0, mem.outsideBytes) / mem.totalBytes;
  const holdersActualRatio = holdersActual / mem.totalBytes;
  // Compressed/swapped pages leave ps RSS and show up in kernel-used memory (1 - freeRatio): taking
  // the larger of both catches outside use before and after kernel compression kicks in.
  const outsideKernelRatio =
    sample.freeRatio !== null ? Math.max(0, 1 - sample.freeRatio - holdersActualRatio) : 0;
  const outsideRatio = Math.max(outsidePsRatio, outsideKernelRatio);
  const projectedRatio = outsideRatio + (holdersProjected + reserve) / mem.totalBytes;
  return { outsideRatio, projectedRatio };
}

/**
 * One admission decision for the caller at the front of the queue. `next`: cores the caller will use
 * (its declared cores or the slot share). The sample is read only when someone holds a slot.
 */
export function admitHeavy(input: {
  base: number;
  cores: number;
  share: number;
  next: number;
  holders: HeavyHolderUse[];
  sample: () => HeavySample;
}): HeavyDecision {
  const { base, cores, share, next, holders } = input;
  if (!holders.length) return { admit: true, burst: false, reason: null };
  const sample = input.sample();
  if (sample.freeRatio !== null && sample.freeRatio < FREEZE_FREE_RATIO)
    return refuse(`free memory ${percent(sample.freeRatio)} is under ${percent(FREEZE_FREE_RATIO)}`);
  if (sample.pressure != null && sample.pressure >= MACOS_PRESSURE_WARN)
    return refuse(
      `kernel memory pressure is ${sample.pressure >= 4 ? 'critical' : 'warning'} (level ${sample.pressure})`,
    );
  const projectedMem = projectMemory(holders, sample);
  if (holders.length < base) {
    const ceiling = 1 - FREEZE_FREE_RATIO;
    if (projectedMem && projectedMem.projectedRatio > ceiling)
      return refuse(
        `memory outside heavy ${percent(projectedMem.outsideRatio)} plus ${holders.length} holder(s) and next would need ${percent(projectedMem.projectedRatio)} of RAM (limit ${percent(ceiling)})`,
      );
    return { admit: true, burst: false, reason: null };
  }
  const limit = heavyBurstLimit(base, cores);
  if (holders.length >= limit)
    return refuse(`${holders.length} commands hold slots (most at once: ${limit})`);
  if (sample.freeRatio !== null && sample.freeRatio < BURST_FREE_RATIO)
    return refuse(
      `free memory ${percent(sample.freeRatio)} is under ${percent(BURST_FREE_RATIO)} for an extra slot`,
    );
  if (sample.swapUsedRatio !== null && sample.swapUsedRatio >= BURST_SWAP_RATIO)
    return refuse(`swap ${percent(sample.swapUsedRatio)} used`);
  const burstCeiling = 1 - BURST_FREE_RATIO;
  if (projectedMem && projectedMem.projectedRatio > burstCeiling)
    return refuse(
      `memory outside heavy ${percent(projectedMem.outsideRatio)} plus ${holders.length} holder(s) and next would need ${percent(projectedMem.projectedRatio)} of RAM (limit ${percent(burstCeiling)} for an extra slot)`,
    );
  // Pid 0: a slot still being claimed (and the kernel's own tree on macOS), never measured.
  const used = holders.reduce(
    (sum, holder) => sum + holderWeight(holder, share, holder.pid > 1 ? sample.cpu(holder.pid) : null),
    0,
  );
  const projected = Math.max(sample.load ?? used, used) + next;
  if (projected > cores)
    return refuse(
      `load ${round(sample.load ?? used)}, holders use ${round(used)} cores; ${next} more would need ${round(projected)} of ${cores}`,
    );
  return { admit: true, burst: true, reason: null };
}
const refuse = (reason: string): HeavyDecision => ({ admit: false, burst: false, reason });

const fraction = (part: number, whole: number) => (whole > 0 ? Math.min(1, Math.max(0, part / whole)) : null);
/** Free memory, swap and macOS kernel memory pressure: macOS `kern.memorystatus_level` and
 * `kern.memorystatus_vm_pressure_level` (swap there grows on demand, so used/total is no signal:
 * 98% used at load 7), Linux MemAvailable and swap, elsewhere freemem. */
export function readMemory(
  platform = process.platform,
): Pick<HeavySample, 'freeRatio' | 'swapUsedRatio' | 'pressure'> {
  try {
    if (platform === 'darwin') {
      let lines: string[];
      try {
        lines = execFileSync(
          'sysctl',
          ['-n', 'kern.memorystatus_level', 'kern.memorystatus_vm_pressure_level'],
          {
            encoding: 'utf8',
            timeout: 2000,
            stdio: ['ignore', 'pipe', 'ignore'],
          },
        )
          .trim()
          .split(/\s+/);
      } catch {
        // Fall back to the free-level key alone if pressure_level is unavailable on this macOS.
        lines = [
          execFileSync('sysctl', ['-n', 'kern.memorystatus_level'], {
            encoding: 'utf8',
            timeout: 2000,
            stdio: ['ignore', 'pipe', 'ignore'],
          }).trim(),
        ];
      }
      const level = Number(lines[0]);
      const pressure = Number(lines[1]);
      if (Number.isFinite(level) && level >= 0 && level <= 100)
        return {
          freeRatio: level / 100,
          swapUsedRatio: null,
          pressure: Number.isFinite(pressure) && pressure > 0 ? pressure : null,
        };
    } else if (platform === 'linux') {
      const info = readFileSync('/proc/meminfo', 'utf8');
      const field = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(info)?.[1] ?? NaN);
      const [total, available, swapTotal, swapFree] = [
        'MemTotal',
        'MemAvailable',
        'SwapTotal',
        'SwapFree',
      ].map(field);
      if (Number.isFinite(total) && Number.isFinite(available))
        return {
          freeRatio: fraction(available!, total!),
          swapUsedRatio:
            swapTotal! > 0 && Number.isFinite(swapFree) ? fraction(swapTotal! - swapFree!, swapTotal!) : null,
          pressure: null,
        };
    }
  } catch {}
  return { freeRatio: fraction(freemem(), totalmem()), swapUsedRatio: null, pressure: null };
}

/** The live sample: load and memory now, holders' CPU and outside-slot RSS from one `ps` taken on
 * first use. Only macOS's `ps` CPU is recent use (a decaying average); Linux procps reports CPU
 * over the process lifetime, so there CPU stays unmeasured while RSS is live on both Unixes. */
export function readHeavySample(platform = process.platform): HeavySample {
  const unix = platform !== 'win32';
  const measuredCpu = platform === 'darwin';
  let ps: string | null | undefined;
  const readPs = () => {
    if (!unix) return null;
    if (ps === undefined)
      try {
        ps = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pcpu=,rss='], {
          encoding: 'utf8',
          timeout: 5000,
          maxBuffer: 1 << 22,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch {
        ps = null;
      }
    return ps;
  };
  return {
    load: unix ? loadavg()[0]! : null,
    ...readMemory(platform),
    cpu(pid) {
      if (!measuredCpu) return null;
      const table = readPs();
      return table === null ? null : treeCpu(table, pid);
    },
    memoryUse(holderPids) {
      const table = readPs();
      return table === null ? null : parseProcessMemory(table, holderPids);
    },
  };
}
/** One sample reused for `ms`: a burst of queue changes re-runs attempts, not reads. */
export function cachedSample(read: () => HeavySample = readHeavySample, ms = 2000, now = Date.now) {
  let last: { at: number; sample: HeavySample } | null = null;
  return () => {
    if (!last || now() - last.at >= ms) last = { at: now(), sample: read() };
    return last.sample;
  };
}

/** What `acquireHeavySlot` asks per attempt (heavy-slots.ts stays free of this module, which only a
 * heavy command loads): the most holders at `base` slots, and the decision for these holders. */
export type HeavyAdmission = {
  limit(base: number): number;
  decide(base: number, holders: HeavyHolderUse[]): HeavyDecision;
};
/** The measured admission for a caller using `declared` cores (null: the slot share). */
export function heavyAdmission(options: {
  cores: number;
  declared?: number | null;
  sample?: () => HeavySample;
}): HeavyAdmission {
  const sample = options.sample ?? cachedSample();
  return {
    limit: base => heavyBurstLimit(base, options.cores),
    decide(base, holders) {
      const share = testWorkersPerSlot(options.cores, base);
      return admitHeavy({
        base,
        cores: options.cores,
        share,
        next: options.declared ?? share,
        holders,
        sample,
      });
    },
  };
}
