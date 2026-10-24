// SPDX-License-Identifier: Apache-2.0
import { Glyph } from '../ui/Glyph';
import { useNow } from '../shell/StatusBar';
import { age } from '../ui/status';
export type ReviewAcceptance = {
  at: string;
  channel?: string;
  actor?: unknown;
  actorDisplayName?: string;
  actorFormerMember?: boolean;
};
export function acceptanceName(acceptance: ReviewAcceptance) {
  const actor = acceptance.actor;
  const name =
    acceptance.actorDisplayName ??
    (actor && typeof actor === 'object' && 'name' in actor
      ? String(actor.name)
      : typeof actor === 'string'
        ? actor
        : '');
  return !name || name === 'Agent workflow' || name.includes('_') || /^[a-f0-9-]{32,}$/i.test(name)
    ? '—'
    : name;
}
/** Historical Views show their retained outcome, without a second decision surface. */
export function ReviewDisposition({
  acceptance,
  replacement,
}: {
  acceptance?: ReviewAcceptance;
  replacement?: { href: string; label: string; check?: string };
}) {
  const now = useNow();
  if (acceptance)
    return (
      <p className="fx-review-disposition fx-c-passed" title={acceptance.at}>
        <Glyph name="passed" size={13} />
        Accepted into {acceptance.channel ?? 'main'} {age(acceptance.at, now, true)} by{' '}
        {acceptanceName(acceptance)}
        {acceptance.actorFormerMember && <small className="fx-faint"> · former member</small>}
      </p>
    );
  if (replacement)
    return (
      <p className="fx-review-disposition fx-faint">
        <Glyph name="stale" size={13} />
        <a href={replacement.href}>Superseded by {replacement.label}</a>
        {replacement.check ? ` · ${replacement.check}` : ''}
      </p>
    );
  return null;
}
