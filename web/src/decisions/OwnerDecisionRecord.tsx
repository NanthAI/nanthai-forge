// SPDX-License-Identifier: Apache-2.0
import type { DecisionRecord } from '../../../src/decision-types';
import { Glyph } from '../ui/Glyph';
import { StatusPill } from '../ui/primitives';
import { age } from '../ui/status';
import { decisionDate, decisionExcerpt, replacementsFor, targetName, type DecisionIntent } from './model';
import './decisions.css';

export type DecisionLinks = {
  recordHref: (id: string) => string;
  intentHref: (id: string) => string;
  documentHref: (link: string) => string | undefined;
};
export type DecisionProps = DecisionLinks & {
  record: DecisionRecord;
  records: readonly DecisionRecord[];
  intents: readonly DecisionIntent[];
  now: number;
  compact?: boolean;
};
export function OwnerDecisionRecord({
  record,
  records,
  intents,
  now,
  compact,
  recordHref,
  intentHref,
  documentHref,
}: DecisionProps) {
  const replacedBy = replacementsFor(records, record.id);
  const target = targetName(record, intents);
  const earlier =
    record.overrides?.kind === 'decision'
      ? records.find(item => record.overrides?.kind === 'decision' && item.id === record.overrides.decisionId)
      : undefined;
  const replaces = record.supersedes && records.find(item => item.id === record.supersedes);
  const link = record.overrides?.link;
  const href = link && documentHref(link);
  if (compact)
    return (
      <div className="fx-odec-compact">
        <a href={recordHref(record.id)}>{record.what}</a>
        <small>
          {target} ·{' '}
          <time title={record.decidedAt}>
            {record.decidedAt.length === 10 ? decisionDate(record.decidedAt) : age(record.decidedAt, now)}
          </time>{' '}
          · entered by {record.actor.name}
        </small>
      </div>
    );
  return (
    <article className={`fx-odec${replacedBy.length ? ' fx-odec-superseded' : ''}`}>
      <div className="fx-odec-kind">
        <span className="fx-concept">
          <Glyph name={record.target.kind === 'project' ? 'claim' : 'intent'} size={12} />
          {record.target.kind === 'intent' ? (
            <a href={intentHref(record.target.intentId)}>{target}</a>
          ) : (
            target
          )}
        </span>
        <span>decided by {record.decidedBy}</span>
        {replacedBy.length > 0 && <StatusPill tone="stale">Superseded</StatusPill>}
        <time className="fx-odec-age" dateTime={record.decidedAt} title={record.decidedAt}>
          {record.decidedAt.length === 10 ? decisionDate(record.decidedAt) : age(record.decidedAt, now)}
        </time>
      </div>
      <div className="fx-odec-what">
        <a href={recordHref(record.id)}>{record.what}</a>
      </div>
      <div className="fx-odec-why">{record.why}</div>
      {(record.overrides || replaces || replacedBy.length > 0) && (
        <div className="fx-odec-links">
          {record.overrides && (
            <span>
              <Glyph name="arrow" size={12} />
              <span>
                <i>Overrides {record.overrides.kind}</i> ·{' '}
                {record.overrides.kind === 'default' ? (
                  record.overrides.description
                ) : earlier ? (
                  <a href={recordHref(earlier.id)} title={earlier.what}>
                    {decisionExcerpt(earlier.what)}
                  </a>
                ) : (
                  'Earlier decision unavailable'
                )}
                {link && <> · {href ? <a href={href}>{link}</a> : <span>{link}</span>}</>}
              </span>
            </span>
          )}
          {replaces &&
            !(record.overrides?.kind === 'decision' && record.overrides.decisionId === replaces.id) && (
              <span>
                <Glyph name="undo" size={12} />
                <span>
                  <i>Replaces</i> ·{' '}
                  <a href={recordHref(replaces.id)} title={replaces.what}>
                    {decisionExcerpt(replaces.what)}
                  </a>
                </span>
              </span>
            )}
          {replacedBy.map(replacement => (
            <span key={replacement.id}>
              <Glyph name="arrow" size={12} />
              <span>
                <i>Superseded by</i> ·{' '}
                <a href={recordHref(replacement.id)} title={replacement.what}>
                  {decisionExcerpt(replacement.what)}
                </a>{' '}
                <i>· {decisionDate(replacement.decidedAt, true)}</i>
              </span>
            </span>
          ))}
        </div>
      )}
      <div className="fx-odec-foot">
        <span>
          entered by {record.actor.name}{' '}
          {record.actor.kind === 'agent' && <span className="fx-agent-tag">agent</span>}
        </span>
        {Math.abs(Date.parse(record.at) - Date.parse(record.decidedAt)) >= 86_400_000 && (
          <span>
            · recorded <time title={record.at}>{decisionDate(record.at, true)}</time>
          </span>
        )}
      </div>
    </article>
  );
}
