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
};

/** The server summary may end mid-path at 240 characters. Never invent a test count or path. */
function failedTests(summary: string) {
  const list = summary.match(/^(?:Reverted|Fix needed for) receipt [^:]+: (.*?) failed on /)?.[1];
  if (!list || list === 'static/unknown failure') return { tests: [] };
  const more = list.match(/ \(\+(\d+) more\)$/);
  const tests = list
    .replace(/ \(\+\d+ more\)$/, '')
    .split(', ')
    .filter(Boolean);
  return { tests, more: Number(more?.[1] ?? 0) };
}

/** Resolve all titles once; notice rendering adds no per-Intent reads. */
export function needsFixDecisions(
  notices: readonly NeedsFixNotice[],
  intents: readonly { id: string; outcome: string }[],
): DecisionItem[] {
  const titles = new Map(intents.map(intent => [intent.id, intent.outcome]));
  return notices.map(notice => {
    const { tests, more } = failedTests(notice.summary);
    const count = more === undefined ? undefined : tests.length + more;
    const failure = `main audit failed${count === undefined ? '' : ` ${count} ${count === 1 ? 'test' : 'tests'}`}`;
    const subtitle = !notice.auditRunId
      ? 'reverted on main after it landed; its Lane keeps the change'
      : `${failure}${notice.state === 'reverted' ? ' after it landed' : '; no single culprit, main unchanged'}`;
    return {
      id: `needsfix:${notice.intentId}`,
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
