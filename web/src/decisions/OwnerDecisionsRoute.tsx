// SPDX-License-Identifier: Apache-2.0
import { useDestination } from '../WorkspaceUI';
import { hostedHref } from '../cockpit/hosted-links';
import { Glyph } from '../ui/Glyph';
import { decisionDate } from './model';
import { useOwnerDecisions } from './context';
import { OwnerDecisionPage } from './OwnerDecisionPage';
import { OwnerDecisionsList } from './OwnerDecisionsList';
export function OwnerDecisionsRoute() {
  const [id] = useDestination('decision');
  const { records, intents, now, links, loading, unavailable } = useOwnerDecisions();
  const record = records.find(record => record.id === id);
  return (
    <div className="fx-page">
      <nav className="fx-crumbs" aria-label="Breadcrumb">
        <a href={hostedHref({ projectTab: 'intent' })}>Work</a>
        <Glyph name="chevron" size={12} />
        {id ? (
          <>
            <a href={hostedHref({ projectTab: 'decisions' })}>Decisions</a>
            <Glyph name="chevron" size={12} />
            <span aria-current="page">
              {record ? `Decision · ${decisionDate(record.decidedAt)}` : 'Decision'}
            </span>
          </>
        ) : (
          <span aria-current="page">Decisions</span>
        )}
      </nav>
      {unavailable ? (
        <p className="fx-panel-note">Owner decisions unavailable.</p>
      ) : loading ? (
        <p className="fx-panel-note" role="status">
          Reading owner decisions…
        </p>
      ) : id ? (
        record ? (
          <div className="fx-work-grid">
            <div>
              <h1 className="fx-odec-page-title">Owner decision</h1>
              <OwnerDecisionPage {...links} {...{ record, records, intents, now }} />
            </div>
          </div>
        ) : (
          <p className="fx-panel-note">This owner decision is not available in the selected Work index.</p>
        )
      ) : (
        <OwnerDecisionsList {...links} {...{ records, intents, now }} />
      )}
    </div>
  );
}
