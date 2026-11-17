// SPDX-License-Identifier: Apache-2.0
// The Mirror screen's marks (Item c63c2171): each recorded mirror state as one state word and the distance between
// the two ends, and the ends themselves said from the recorded heads.
import type { StateKind, StateWord } from '../../ds';
import type { MirrorState } from '../../../../src/github-mirror-sentence';

const marks: Record<MirrorState, { word: StateWord; state: StateKind; gap: string }> = {
  off: { word: 'Not run', state: 'stale', gap: 'not connected' },
  level: { word: 'Landed', state: 'passed', gap: 'level' },
  behind: { word: 'Working', state: 'active', gap: 'behind, pushing' },
  retrying: { word: 'Waiting its turn', state: 'waiting', gap: 'behind, retrying' },
  moved: { word: 'Needs you', state: 'waiting', gap: 'apart' },
  refused: { word: 'Needs you', state: 'waiting', gap: 'push refused' },
  stopped: { word: 'Needs you', state: 'waiting', gap: 'stopped' },
  'inbound-failed': { word: 'Check failed', state: 'failed', gap: '1 not accepted' },
  'not-pushed': { word: 'Not run', state: 'stale', gap: 'not pushed yet' },
  unknown: { word: 'Not reported', state: 'stale', gap: 'not known yet' },
};
export function mirrorStateMark(state: string) {
  return marks[state as MirrorState] ?? marks.unknown;
}

type Ends = {
  forgeHead: string | null;
  mirroredHead: string | null;
  gitHead: string | null;
  mirroredAt: number | null;
} | null;
/** Short heads for the two ends; `when` is the last push, said once. */
export function endsWords({ ends, direction }: { ends: Ends; direction: string }) {
  const short = (head: string | null | undefined) => (head ? head.slice(0, 7) : '—');
  return {
    forge: short(ends?.forgeHead),
    github: direction === 'off' && !ends ? null : short(ends?.gitHead),
    when: ends?.mirroredAt
      ? `last push ${new Date(ends.mirroredAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`
      : null,
  };
}
