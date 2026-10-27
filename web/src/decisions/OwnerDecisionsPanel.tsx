// SPDX-License-Identifier: Apache-2.0
import type { DecisionRecord } from '../../../src/decision-types';
import { Panel } from '../ui/primitives';
import { hostedHref } from '../cockpit/hosted-links';
import { activeDecisions, recentDecisions } from './model';
import { OwnerDecisionRecord } from './OwnerDecisionRecord';
import { useOwnerDecisions } from './context';
const listHref = () => hostedHref({ projectTab: 'decisions' });

export function OwnerDecisionsPanel({ intentId }: { intentId: string }) {
  const { records, intents, now, links, loading, unavailable } = useOwnerDecisions();
  const active = activeDecisions(records, intentId);
  const scoped = records.filter(
    record => record.target.kind === 'intent' && record.target.intentId === intentId,
  );
  const project = active.filter(record => record.target.kind === 'project').length;
  // TODO(B1.5b): enable Record after hosted decision writes arrive.
  return (
    <Panel
      className="fx-owner-decisions-panel"
      title="Owner decisions"
      count={scoped.length}
      footer={
        project > 0 && (
          <>
            {project} project-wide {project === 1 ? 'decision also applies' : 'decisions also apply'} ·{' '}
            <a href={listHref()}>Work › Decisions</a>
          </>
        )
      }
    >
      {scoped.length ? (
        scoped.map(record => (
          <OwnerDecisionRecord key={record.id} {...links} {...{ record, records, intents, now }} />
        ))
      ) : (
        <p className="fx-panel-note">
          {unavailable
            ? 'Owner decisions unavailable.'
            : loading
              ? 'Reading owner decisions…'
              : 'No owner decisions for this Intent.'}
        </p>
      )}
    </Panel>
  );
}

/** A record is context, never a Needs-you item. No reads, effects or timers. */
export function OwnerDecisionsPointer() {
  const { records, intents, now, links } = useOwnerDecisions();
  const recent = recentDecisions(records, now);
  if (!recent.length) return null;
  const today = new Date(now).toISOString().slice(0, 10);
  const moreToday = recent.slice(3).filter(record => record.at.slice(0, 10) === today).length;
  return (
    <Panel
      className="fx-owner-decisions-pointer"
      title="Owner decisions"
      count={recent.length}
      actions={<a href={listHref()}>All</a>}
      footer={
        <>
          {moreToday > 0 && <>{moreToday} more today · </>}in <a href={listHref()}>Work › Decisions</a>
        </>
      }
    >
      {recent.slice(0, 3).map(record => (
        <OwnerDecisionRecord key={record.id} {...links} {...{ record, records, intents, now }} compact />
      ))}
    </Panel>
  );
}

/** All applicable active decisions stay in a native disclosure, closed on first render. */
export function OwnerDecisionsDisclosure({ intentId }: { intentId: string }) {
  const { records, intents, now, links } = useOwnerDecisions();
  const applicable = activeDecisions(records, intentId);
  const scoped = applicable.filter(record => record.target.kind === 'intent');
  const project = applicable.filter(record => record.target.kind === 'project');
  if (!applicable.length) return null;
  // Records have no structured gate field yet. Explicit acceptance/check overrides are context only;
  // never infer or change the actual gate from prose (B1.2d owns gate rendering).
  const touchesAcceptance = (record: DecisionRecord) =>
    /accept|landing|gate|check|suite/i.test(
      [record.what, record.overrides?.kind === 'default' ? record.overrides.description : ''].join(' '),
    );
  const shown = [...scoped, ...project.filter(touchesAcceptance)];
  return (
    <details className="fx-panel fx-record fx-odec-disclosure">
      <summary>
        Owner decisions in effect · {scoped.length} for this Intent · {project.length} project
      </summary>
      {shown.map(record => (
        <OwnerDecisionRecord key={record.id} {...links} {...{ record, records, intents, now }} compact />
      ))}
      <footer className="fx-panel-f">
        {project.length - shown.length + scoped.length > 0 && (
          <>{project.length - shown.length + scoped.length} more project decisions · </>
        )}
        <a href={listHref()}>Work › Decisions</a>
      </footer>
    </details>
  );
}
