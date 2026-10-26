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
  reverted,
  check,
}: {
  reverted?: { href: string; label: string; at: string; why?: string; actor?: string; check?: string };
  check?: string;
  acceptance?: ReviewAcceptance;
  replacement?: { href: string; label: string; check?: string };
}) {
  const now = useNow();
  if (reverted)
    return (
      <div className="fx-landed">
        <Glyph name="passed" size={13} />
        <div>
          Reverted {age(reverted.at, now, true)} by <a href={reverted.href}>{reverted.label}</a>
          {reverted.actor && ` · accepted by ${acceptanceName({ actor: reverted.actor, at: reverted.at })}`}
          {reverted.check && ` · ${reverted.check} passed`}
          {reverted.why && <p className="fx-faint">{reverted.why}</p>}
        </div>
      </div>
    );
  if (acceptance)
    return (
      <p className="fx-review-disposition fx-c-passed" title={acceptance.at}>
        <Glyph name="passed" size={13} />
        {acceptance.channel && acceptance.channel !== 'main' ? 'Accepted into' : 'Landed on'}{' '}
        {acceptance.channel ?? 'main'} {age(acceptance.at, now, true)} by {acceptanceName(acceptance)}
        {check && ` · ${check} passed on exactly this Candidate`}
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
