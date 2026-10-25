// SPDX-License-Identifier: Apache-2.0
import type { DecisionProps } from './OwnerDecisionRecord';
import { OwnerDecisionRecord } from './OwnerDecisionRecord';
import { Glyph } from '../ui/Glyph';
import { ExactRecord, Panel } from '../ui/primitives';
import { decisionDate, decisionExcerpt, replacementsFor } from './model';
export function OwnerDecisionPage(props: DecisionProps) {
  const { record, records, recordHref, documentHref } = props;
  const replacement = replacementsFor(records, record.id);
  const previous = record.supersedes && records.find(item => item.id === record.supersedes);
  const document = record.overrides?.link;
  const docHref = document && documentHref(document);
  return (
    <Panel className={`fx-odec-record${replacement.length ? ' fx-odec-record-stale' : ''}`}>
      <OwnerDecisionRecord {...props} />
      <div className="fx-odec-chain">
        <div>
          <span className={`fx-gate-icon fx-odec-chain-${replacement.length ? 'stale' : 'plain'}`}>
            <Glyph name={replacement.length ? 'stale' : 'claim'} size={11} />
          </span>
          <div>
            <b>This decision · {decisionDate(record.decidedAt)}</b>
            <small title={record.what}>{decisionExcerpt(record.what, 105)}</small>
          </div>
        </div>
        {replacement.map(next => (
          <div key={next.id}>
            <span className="fx-gate-icon fx-odec-chain-passed">
              <Glyph name="arrow" size={11} />
            </span>
            <div>
              <b>
                <a href={recordHref(next.id)}>Superseded by · {decisionDate(next.decidedAt, true)}</a>
              </b>
              <small title={next.what}>{decisionExcerpt(next.what, 105)}</small>
            </div>
          </div>
        ))}
        {previous && (
          <div>
            <span className="fx-gate-icon fx-odec-chain-plain">
              <Glyph name="undo" size={11} />
            </span>
            <div>
              <b>
                <a href={recordHref(previous.id)}>Replaces · {decisionDate(previous.decidedAt, true)}</a>
              </b>
              <small title={previous.what}>{decisionExcerpt(previous.what, 105)}</small>
            </div>
          </div>
        )}
        {document && (
          <div>
            <span className="fx-gate-icon fx-odec-chain-plain">
              <Glyph name="file" size={11} />
            </span>
            <div>
              <b>
                {record.overrides?.kind === 'default' ? record.overrides.description : 'Documents it changed'}
              </b>
              <small>{docHref ? <a href={docHref}>{document}</a> : document}</small>
            </div>
          </div>
        )}
      </div>
      <ExactRecord
        summary="Exact record"
        rows={[
          ['Decision', record.id],
          ['Superseded by', replacement.map(next => next.id).join(', ') || undefined],
          ['Supersedes', record.supersedes],
          ['Target', record.target.kind === 'project' ? 'project' : `intent:${record.target.intentId}`],
          ['Decided by', record.decidedBy],
          ['Decided at', record.decidedAt],
          ['Recorded at', record.at],
          ['Entered by', `${record.actor.name} · ${record.actor.kind}`],
          ['Operation', record.operationId],
        ]}
      />
    </Panel>
  );
}
