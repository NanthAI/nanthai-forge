// SPDX-License-Identifier: Apache-2.0
import { PRESENCE, presenceState } from '../../../src/presence';
/** Visual status vocabulary shared by every cockpit surface. Colour is always paired with a glyph. */
export type Tone = 'active' | 'waiting' | 'stale' | 'conflict' | 'passed' | 'failed' | 'running' | 'plain';

/** Working activity window; quiet sessions remain listed until PRESENCE.foldMs. */
export const STALE_AFTER_MS = PRESENCE.workingMs;

export function freshness(lastSeen: number, now: number, status?: string): Tone {
  const state = presenceState({ lastSeen, status: status ?? 'working' }, now);
  if (state === 'completed') return 'plain';
  if (state === 'not-seen') return 'stale';
  if (state === 'quiet') return 'plain';
  return status === 'waiting' ? 'waiting' : 'active';
}

/** Compact relative age: "just now", "40 s", "12 min", "3 h", "2 d", then a date. */
export function age(at: number | string | undefined, now: number, ago = false): string {
  const value = compactAge(at, now);
  return value && ago && value !== 'just now' ? `${value} ago` : value;
}

function compactAge(at: number | string | undefined, now: number): string {
  if (at === undefined) return '';
  const time = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(time)) return '';
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} d`;
  return new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Wall-clock last-seen: "19:23" today, "yesterday 19:23", then "15 Oct". */
export function seenAt(at: number, now: number): string {
  const day = (time: number) => new Date(time).setHours(0, 0, 0, 0);
  const clock = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days <= 0) return clock;
  if (days === 1) return `yesterday ${clock}`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/[\s-]+/)
    .filter(Boolean);
  if (words.length === 0) return '?';
  const [first, second] = words;
  if (!second) {
    const letters = first!.match(/\p{L}/gu) ?? [];
    const digits = first!.match(/\p{N}+$/u)?.[0] ?? '';
    return ((letters[0] ?? first![0]!) + (digits || letters[1] || '')).toUpperCase().slice(0, 2);
  }
  return (first![0]! + second[0]!).toUpperCase();
}

const HUES = [210, 265, 20, 160, 330, 95, 190, 45] as const;
/** Stable, theme-independent avatar hue chosen from a fixed set by hashing an identity. */
export function hue(identity: string): number {
  let hash = 2166136261;
  for (let i = 0; i < identity.length; i++) hash = Math.imul(hash ^ identity.charCodeAt(i), 16777619);
  return HUES[Math.abs(hash) % HUES.length]!;
}

/** Status words: Conflict · Check failed · Ready · Working · Waiting · Not seen. Never a hash or a record name. */
export const toneLabel: Record<Tone, string> = {
  active: 'Working',
  waiting: 'Waiting',
  stale: 'Not seen',
  conflict: 'Conflict',
  passed: 'Ready',
  failed: 'Check failed',
  running: 'Checking',
  plain: 'Done',
};

/** Attention order: what needs a decision sorts first. */
export const attentionRank: Record<Tone, number> = {
  conflict: 0,
  failed: 1,
  passed: 2,
  waiting: 3,
  running: 4,
  active: 5,
  stale: 6,
  plain: 7,
};

export function shortHash(value: string | undefined, length = 7): string {
  return value ? value.slice(0, length) : '';
}

/** Only live check states animate. Terminal and unknown states remain static. */
export function checkStatus(status: string): {
  tone: 'passed' | 'failed' | 'running' | 'waiting' | 'plain';
  glyph: 'passed' | 'failed' | 'running' | 'waiting' | 'plain';
  label: string;
} {
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  if (status === 'passed') return { tone: 'passed', glyph: 'passed', label };
  if (status === 'failed') return { tone: 'failed', glyph: 'failed', label };
  if (status === 'queued') return { tone: 'waiting', label: 'Queued', glyph: 'waiting' };
  if (['preparing', 'running'].includes(status)) return { tone: 'running', glyph: 'running', label };
  return { tone: 'plain', glyph: 'plain', label };
}
