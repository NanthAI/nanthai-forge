// SPDX-License-Identifier: Apache-2.0
import type { DecisionContext } from './decision-types.js';
const plain = (text: string) => text.replace(/[\r\n\x00-\x1f\x7f]/g, ' ');
export function formatDecisionContext(decisions: DecisionContext): string {
  if (!decisions.active.length && !decisions.superseded.length) return '';
  return [
    '## Owner decisions',
    'Recorded context; decisions do not themselves change policy or grant authority.',
    ...decisions.active.map(record => {
      const override = record.overrides;
      const target = record.target.kind === 'project' ? 'project' : `Intent ${record.target.intentId}`;
      return [
        `- Active decision ${record.id} (${target}): ${plain(record.what)}`,
        `  Decided by ${plain(record.decidedBy)} at ${record.decidedAt}. Why: ${plain(record.why)}`,
        `  Overrides: ${override ? (override.kind === 'decision' ? `decision ${override.decisionId}` : plain(override.description)) : 'none recorded'}${override?.link ? ` (${plain(override.link)})` : ''}.${record.supersedes ? ` Supersedes decision ${record.supersedes}.` : ''}`,
      ].join('\n');
    }),
    ...decisions.superseded.map(
      record =>
        `- Superseded decision ${record.id}: ${plain(record.what)} → ${record.supersededBy.join(', ')}`,
    ),
    '',
  ].join('\n');
}
