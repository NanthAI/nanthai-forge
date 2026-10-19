// SPDX-License-Identifier: Apache-2.0
import { PagedList, ScaleGroups } from './cockpit/ScaleList';
import { groupByInitiative, initiativeLinks, SCALE_AFTER } from './cockpit/scale-model';
import type { PlanningItem } from '../../src/work-planning-types';
import { useWorkRecords } from './hosted-work-index';
import { PageHead } from './shell/Shell';
import { useWorkHeader } from './shell/WorkHeader';
import { useMemo, useState } from 'react';
import type { Id } from '../../convex/_generated/dataModel';
import type { Lane, WorkData } from '../../src/work-types';
import type { HostedRunSummary, HostedViewSummary } from '../../src/work-hosted-summary';
import { useWorkRecordResult, type WorkIndexWorkspace, type IntentHeader } from './hosted-work-index';
import { PageTabs, useDestination, useSection, ActionPanel, Icon, LazyPage } from './WorkspaceUI';
import { Panel, Segmented } from './ui/primitives';
import { Glyph } from './ui/Glyph';
import { LaneFactLine, WorkRow } from './ui/WorkRow';
import { filterLaneFacts, laneFacts, type LaneFact, type LaneFilter } from './ui/lane-facts';
import { age } from './ui/status';
import { cockpitLanes, type CockpitLane, type CockpitWork } from './cockpit/model';
import { usePresenceSessions, withSessions } from './cockpit/coordination';
import { hostedHref } from './cockpit/hosted-links';
import type { Session } from './coordination-view';
import { useNow } from './shell/StatusBar';
import { WorkStatus } from './WorkStatus';
import { WorkTimeline } from './WorkTimeline';
import ProjectCoordination from './ProjectCoordination';
import NativeSourceReview from './NativeSourceReview';
import { HostedLane } from './lane/HostedLane';
import { HostedLaneChanges } from './lane/HostedLaneChanges';
export default function HostedLanes({
  projectId,
  workspace,
  lanes,
  intents,
  loading,
  intentId,
  active = true,
  openIntent,
  embedded = false,
}: {
  /** Inside the shared shell: a selected Lane opens the cockpit Lane screen. */
  embedded?: boolean;
  projectId: Id<'hostedProjects'>;
  workspace: WorkIndexWorkspace;
  lanes: Lane[];
  intents: IntentHeader[];
  loading: boolean;
  intentId?: string;
  active?: boolean;
  openIntent: (id: string) => void;
}) {
  const workHeader = useWorkHeader();
  const planning = useWorkRecords<PlanningItem>(projectId, workspace, 'planningItems');
  const views = useWorkRecords<HostedViewSummary>(projectId, workspace, 'views');
  const runs = useWorkRecords<HostedRunSummary>(projectId, workspace, 'runs');
  const moves = useWorkRecords<WorkData['channelMoves'][number]>(projectId, workspace, 'channelMoves');
  const now = useNow();
  const [selected, choose] = useDestination('lane'),
    [tab, setTab] = useSection('laneTab', ['changes', 'history', 'activity'] as const, 'changes');
  const sessions = usePresenceSessions(projectId, !selected);
  const selectedLane = useWorkRecordResult<Lane>(projectId, workspace, 'lanes', selected);
  const lane = selectedLane.header;
  const scoped = lanes.filter(item => !intentId || item.intentId === intentId),
    open = scoped.filter(item => !['completed', 'abandoned'].includes(item.state));
  const current = lane && (!intentId || lane.intentId === intentId) ? lane : null;
  const records = useMemo(
    () => ({
      intents,
      lanes: lanes.filter(item => !intentId || item.intentId === intentId),
      views: views.records,
      runs: runs.records,
      channelMoves: moves.records,
    }),
    [intents, lanes, intentId, views.records, runs.records, moves.records],
  );
  if (embedded && selected && current)
    return (
      <HostedLane
        projectId={projectId}
        workspace={workspace}
        laneId={current.id}
        lane={current}
        selectedLane={selectedLane.record}
        changes={
          <HostedLaneChanges
            key={current.id + current.head + workspace.backupDigest}
            projectId={projectId}
            backupId={workspace.backupId}
            workspace={workspace}
            laneId={current.id}
            peers={open
              .filter(l => l.id !== current.id)
              .map(l => ({ id: l.id, name: l.name, base: l.base, head: l.head }))}
            base={current.base}
            head={current.head}
          />
        }
      />
    );
  return (
    <section className={`lane-workspace${workHeader && !selected && !intentId ? ' fx-page' : ''}`}>
      {workHeader && !selected && !intentId ? (
        <PageHead title="Lanes" />
      ) : (
        <div className="section-heading">
          <div>
            <h2>
              {selected ? (current?.name ?? 'Lane details') : intentId ? 'Lanes for this Intent' : 'Lanes'}
            </h2>
            {(!selected || tab === 'changes') && (
              <p>
                {selected
                  ? 'Changes retained in this Lane, compared with its starting source.'
                  : intentId
                    ? 'Related Lanes keep their own source changes. Open one to inspect its contribution.'
                    : 'All project Lanes keep their own source changes. Open one to inspect its contribution.'}
              </p>
            )}
          </div>
          {current && <WorkStatus status={current.state} />}
        </div>
      )}
      {selected ? (
        <>
          <button className="back-link" onClick={() => choose('')}>
            Back to Lanes
          </button>
          {!current ? (
            !loading && !lanes.some(item => item.id === selected) ? (
              <>
                <h3>Lane not in uploaded Work</h3>
                <p>
                  Activity can arrive before source. Recorded announcements for this Lane are available below.
                </p>
                <ProjectCoordination
                  active={active}
                  projectId={projectId}
                  labels={{ intents, lanes }}
                  scopeLaneId={selected}
                  openIntent={openIntent}
                />
              </>
            ) : (
              <p role="status">
                {lane ? 'This Lane belongs to another Intent. Return to the Lane list.' : 'Loading Lane…'}
              </p>
            )
          ) : (
            <>
              <div className="lane-context-bar">
                <span>
                  <Icon name="agents" />
                  {current.assignment || 'No assignment recorded'}
                </span>
                <button className="text-action" onClick={() => openIntent(current.intentId)}>
                  {intents.find(intent => intent.id === current.intentId)?.outcome ?? 'Open parent Intent'}
                </button>
              </div>
              {current.target && <p>{current.target}</p>}
              <PageTabs
                label="Lane detail"
                value={tab}
                onChange={setTab}
                items={[
                  { id: 'changes', label: 'Source changes', icon: 'source-review' },
                  { id: 'activity', label: 'Activity', icon: 'activity' },
                  { id: 'history', label: 'Timeline', icon: 'clock' },
                ]}
              />
              <LazyPage active={tab === 'activity'}>
                <ProjectCoordination
                  active={active && tab === 'activity'}
                  key={current.id}
                  projectId={projectId}
                  labels={{ intents, lanes }}
                  scopeIntentId={current.intentId}
                  scopeLaneId={current.id}
                  openIntent={openIntent}
                />
              </LazyPage>
              <LazyPage active={tab === 'changes'}>
                <NativeSourceReview
                  key={current.id + current.head + workspace.backupDigest}
                  projectId={projectId}
                  workspace={workspace}
                  intentId={current.intentId}
                  base={current.base}
                  head={current.head}
                  editable={false}
                  busy={false}
                  act={async () => {}}
                />
              </LazyPage>
              <LazyPage active={tab === 'history'}>
                <WorkTimeline
                  label="Lane history"
                  entries={[
                    ...current.checkpoints.map((point, index) => ({
                      id: `checkpoint-${index}`,
                      at: point.at,
                      kind: 'Checkpoint',
                      title: point.message || 'Source checkpoint',
                      detail: (
                        <button className="text-action" onClick={() => setTab('changes')}>
                          Inspect current Lane changes
                        </button>
                      ),
                    })),
                    ...(current.lifecycle ?? []).map((entry, index) => ({
                      id: `status-${index}`,
                      at: entry.at,
                      kind:
                        entry.to === 'completed'
                          ? 'Completed'
                          : entry.to === 'active'
                            ? 'Reopened'
                            : 'Status changed',
                      title: `Lane ${entry.to}`,
                      detail: (
                        <>
                          <WorkStatus status={entry.to} /> {entry.reason} {entry.actor?.name}
                        </>
                      ),
                    })),
                  ]}
                />
              </LazyPage>
              <ActionPanel title="Lane source references">
                <p>
                  Starting source <code>{current.base}</code>
                </p>
                <p>
                  Retained head <code>{current.head}</code>
                </p>
                <p>Changes made locally after this checkpoint are not included.</p>
              </ActionPanel>
            </>
          )}
        </>
      ) : (
        <>
          <LaneListView
            records={records}
            sessions={sessions.results as Session[]}
            now={now}
            loading={loading || views.loading || runs.loading || moves.loading}
            initiatives={initiativeLinks(planning.records)}
            open={id => {
              choose(id);
              setTab('changes');
            }}
          />
        </>
      )}
    </section>
  );
}

const laneHref = (id: string) => hostedHref({ projectTab: 'lanes', lane: id });
type LaneRow = { lane: CockpitLane; fact: LaneFact };
const NOBODY = '\u0000nobody';

/** Lanes list: Open · Ready · Done · All, find, holder filter; every row is the shared Work row. */
export function LaneListView({
  records,
  sessions,
  now,
  loading = false,
  initiatives = new Map(),
  open,
  href = laneHref,
}: {
  records: CockpitWork & { channelMoves?: readonly WorkData['channelMoves'][number][] };
  sessions: readonly Session[];
  now: number;
  loading?: boolean;
  initiatives?: ReturnType<typeof initiativeLinks>;
  open?: (id: string) => void;
  href?: (id: string) => string;
}) {
  const [filter, setFilter] = useState<LaneFilter>('open'),
    [query, setQuery] = useState(''),
    [holder, setHolder] = useState('');
  const rows = useMemo<LaneRow[]>(() => {
    const lanes = withSessions(cockpitLanes(records), sessions, now);
    const facts = laneFacts(records, lanes, now);
    return lanes.map(lane => ({ lane, fact: facts.get(lane.id)! }));
  }, [records, sessions, now]);
  const holders = [
    ...new Set(rows.flatMap(row => (row.fact.open && row.fact.who ? [row.fact.who.name] : []))),
  ].sort((a, b) => a.localeCompare(b));
  const matching = rows.filter(
    ({ lane, fact }) =>
      (!holder || (holder === NOBODY ? fact.open && !fact.who : fact.who?.name === holder)) &&
      [lane.name, lane.intent, fact.who?.name, fact.text]
        .join(' ')
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const shown = filterLaneFacts(matching, filter);
  const label = (name: string, value: LaneFilter) => (
    <>
      {name}
      <span className="fx-filter-count" style={{ visibility: loading ? 'hidden' : 'visible' }}>
        <span className="fx-filter-separator" aria-hidden="true">
          ·
        </span>
        {filterLaneFacts(matching, value).length}
      </span>
    </>
  );
  const render = ({ lane, fact }: LaneRow) => (
    <WorkRow
      key={lane.id}
      tone={fact.tone}
      title={lane.name}
      href={href(lane.id)}
      {...(open ? { onOpen: () => open(lane.id) } : {})}
      label={fact.label}
      {...(fact.pillGlyph ? { pillGlyph: fact.pillGlyph } : {})}
      done={!fact.open}
      fact={<LaneFactLine fact={fact} />}
      age={
        fact.at && (
          <time title={new Date(fact.at).toLocaleString()} dateTime={fact.at}>
            {age(fact.at, now)}
          </time>
        )
      }
    />
  );
  return (
    <Panel className="fx-intent-list-panel fx-lane-list-panel">
      <header className="fx-panel-h fx-intent-toolbar fx-lane-toolbar">
        <Segmented<LaneFilter>
          label="Show Lanes"
          value={filter}
          onChange={setFilter}
          options={[
            { id: 'open', label: label('Open', 'open') },
            { id: 'ready', label: label('Ready', 'ready') },
            { id: 'done', label: label('Done', 'done') },
            { id: 'all', label: label('All', 'all') },
          ]}
        />
        <span className="fx-lane-find">
          <Glyph name="search" size={12} />
          <input
            className="fx-input"
            aria-label="Find a Lane"
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Find a Lane"
          />
        </span>
        <label className="fx-lane-holder">
          <Glyph name="person" size={12} />
          <select
            aria-label="Who holds the Lane"
            value={holder}
            onChange={event => setHolder(event.target.value)}
          >
            <option value="">Anyone</option>
            {holders.map(name => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
            <option value={NOBODY}>Nobody working</option>
          </select>
          <Glyph name="down" size={12} />
        </label>
      </header>
      {loading && !rows.length ? (
        <p className="fx-board-empty" role="status">
          Loading Lanes…
        </p>
      ) : shown.length === 0 ? (
        <p className="fx-board-empty">
          {filter === 'open' && !query && !holder ? 'No open Lanes.' : 'Nothing here.'}
        </p>
      ) : shown.length > SCALE_AFTER ? (
        <ScaleGroups
          groups={groupByInitiative(shown, initiatives, row => row.lane.intentId)}
          noun="Lane"
          render={render}
          className="fx-wrs"
        />
      ) : (
        <PagedList rows={shown} render={render} className="fx-wrs" label="Lanes" />
      )}
    </Panel>
  );
}
