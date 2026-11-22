// SPDX-License-Identifier: Apache-2.0
// Item ff33e9a6: heavy admits by measured CPU, load and memory, not only a fixed count of slots. The
// base slots (localHeavySlots) admit as before; extra "burst" slots open one at a time while the
// machine has room, so a long one-core holder (a model check) no longer blocks test runs at low load.
// A freeze guard (free memory) holds every admission while anyone already holds a slot; load gates
// only the extra slots, so a busy shared runner (load past 2 x cores through a whole suite) keeps
// its base slots as before.
// Local reads only: loadavg, one memory read and at most one `ps` (pids and CPU only) per decision.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { freemem, loadavg, totalmem } from 'node:os';
import { testWorkersPerSlot, treeCpu } from './heavy-hold.js';

/** What one admission decision reads. `cpu(pid)`: cores the pid's process tree uses now (null when
 * unknown); called only for a burst decision, and the `ps` behind it runs at most once per sample. */
export type HeavySample = {
  load: number | null;
  /** Free share of RAM, 0..1 (macOS: the kernel's free percentage, as `memory_pressure` reports). */
  freeRatio: number | null;
  /** Used share of swap, 0..1; null where swap grows on demand (macOS) or there is none. */
  swapUsedRatio: number | null;
  cpu(pid: number): number | null;
};
export type HeavyHolderUse = {
  pid: number;
  elapsedMs: number;
  /** Cores the holder declared (nforge heavy --cores N), if any. */
  declared: number | null;
};
export type HeavyDecision = { admit: boolean; burst: boolean; reason: string | null };

/** Holders younger than this count their full share: `ps` CPU lags a starting command. */
export const HEAVY_SETTLE_MS = 30_000;
/** Freeze guard: no admission while anyone holds a slot and free memory is under this. */
export const FREEZE_FREE_RATIO = 0.1;
/** An extra slot needs about one slot's memory free (heavySlots assumes ~5 GiB a slot on 16 GiB). */
export const BURST_FREE_RATIO = 0.25;
export const BURST_SWAP_RATIO = 0.5;
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
  if (holders.length < base) return { admit: true, burst: false, reason: null };
  const limit = heavyBurstLimit(base, cores);
  if (holders.length >= limit)
    return refuse(`${holders.length} commands hold slots (most at once: ${limit})`);
  if (sample.freeRatio !== null && sample.freeRatio < BURST_FREE_RATIO)
    return refuse(
      `free memory ${percent(sample.freeRatio)} is under ${percent(BURST_FREE_RATIO)} for an extra slot`,
    );
  if (sample.swapUsedRatio !== null && sample.swapUsedRatio >= BURST_SWAP_RATIO)
    return refuse(`swap ${percent(sample.swapUsedRatio)} used`);
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
/** Free memory and swap: macOS `kern.memorystatus_level` (swap there grows on demand, so used/total
 * is no signal: 98% used at load 7), Linux MemAvailable and swap, elsewhere freemem. */
export function readMemory(platform = process.platform): Pick<HeavySample, 'freeRatio' | 'swapUsedRatio'> {
  try {
    if (platform === 'darwin') {
      const level = Number(
        execFileSync('sysctl', ['-n', 'kern.memorystatus_level'], {
          encoding: 'utf8',
          timeout: 2000,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim(),
      );
      if (Number.isFinite(level) && level >= 0 && level <= 100)
        return { freeRatio: level / 100, swapUsedRatio: null };
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
        };
    }
  } catch {}
  return { freeRatio: fraction(freemem(), totalmem()), swapUsedRatio: null };
}

/** The live sample: load and memory now, holders' CPU from one `ps` taken on first use. Only macOS's
 * `ps` CPU is recent use (a decaying average); Linux procps reports CPU over the process lifetime, so
 * a holder that just went busy would look idle: there holders stay unmeasured (their share or their
 * declared cores). */
export function readHeavySample(platform = process.platform): HeavySample {
  const unix = platform !== 'win32';
  const measured = platform === 'darwin';
  let ps: string | null | undefined;
  return {
    load: unix ? loadavg()[0]! : null,
    ...readMemory(platform),
    cpu(pid) {
      if (!measured) return null;
      if (ps === undefined)
        try {
          ps = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pcpu='], {
            encoding: 'utf8',
            timeout: 5000,
            maxBuffer: 1 << 22,
            stdio: ['ignore', 'pipe', 'ignore'],
          });
        } catch {
          ps = null;
        }
      return ps === null ? null : treeCpu(ps, pid);
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
