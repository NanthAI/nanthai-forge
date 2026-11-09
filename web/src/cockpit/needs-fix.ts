// SPDX-License-Identifier: Apache-2.0
import type { DecisionItem } from './attention';

/** Compact recovery notices already carried by the workspace subscription. */
export type NeedsFixNotice = {
  intentId: string;
  at?: string;
  state: 'reverted' | 'needs-fix';
  /** Absent when someone reverted the landing by hand (no main audit asked for it). */
  auditRunId?: string;
  receiptId?: string;
  head: string;
  summary: string;
  undo: string;
  /**
   * The failing test files (at most three) and how many more failed, written by the main audit. Absent on
   * notices recorded before the server wrote them: the count is then unknown, never parsed from `summary`.
   */
  tests?: string[];
  moreTests?: number;
};

/** Resolve all titles once; notice rendering adds no per-Intent reads. */
export function needsFixDecisions(
  notices: readonly NeedsFixNotice[],
  intents: readonly { id: string; outcome: string }[],
): DecisionItem[] {
  const titles = new Map(intents.map(intent => [intent.id, intent.outcome]));
  return notices.map(notice => {
    const tests = notice.tests ?? [];
    const more = notice.moreTests;
    const count = notice.tests === undefined || tests.length === 0 ? undefined : tests.length + (more ?? 0);
    const failure = `main audit failed${count === undefined ? '' : ` ${count} ${count === 1 ? 'test' : 'tests'}`}`;
    const subtitle = !notice.auditRunId
      ? 'reverted on main after it landed; its Lane keeps the change'
      : `${failure}${notice.state === 'reverted' ? ' after it landed' : '; no single culprit, main unchanged'}`;
    return {
      id: `needsfix:${notice.intentId}`,
      // A second notice for the same Intent (a new audit, receipt or head) is a new decision.
      version: [notice.state, notice.auditRunId ?? notice.receiptId ?? notice.head].join(':'),
      kind: notice.state === 'reverted' ? 'revert' : 'needs-fix',
      intentId: notice.intentId,
      ...(notice.at ? { at: notice.at } : {}),
      title: titles.get(notice.intentId) ?? 'Intent',
      subtitle,
      tests,
      ...(more ? { moreTests: more } : {}),
      exact: {
        ...(notice.receiptId ? { reverted: notice.receiptId } : {}),
        ...(notice.auditRunId ? { audit: notice.auditRunId } : {}),
        undo: notice.undo,
      },
    };
  });
}
