import { usePageCritical } from '../ui/page-critical';
import { age, checkStatus } from '../ui/status';
import { WorkMap } from '../views/WorkMap';
import { intentViews } from '../views/intent-views';
import { Breadcrumbs, workHref } from '../shell/Breadcrumbs';
import { ErrorToast } from '../ui/Toast';
import type { Lane, WorkData } from '../../../src/work-types';
import { codeSourceLink, savedLink } from '../shell/ObjectActions';
import { settingsHref } from '../settings/SettingsLayout';
import { Menu } from '../ui/Menu';
import { Glyph } from '../ui/Glyph';
import { routeUrlState } from '../shell/location';
// SPDX-License-Identifier: Apache-2.0
import { useOwnerLifecycle, type LifecycleParts } from './OwnerLifecycle';
import { hostedViewHref } from '../views/links';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useAction, useConvex, useMutation, useQuery } from 'convex/react';
import { BriefSourceContext, hostedBriefs, laneBrief } from '../cockpit/brief';
import { CopyPrompt } from '../cockpit/CopyPrompt';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import type {
  HostedLaneSummary,
  HostedViewSummary,
  HostedRunSummary,
} from '../../../src/work-hosted-summary';
import type { ActivityEvent, Session } from '../coordination-view';
import { withSessions, hostedFeed, usePresenceSessions } from '../cockpit/coordination';
import { cockpitLanes, latestRun, type CockpitWork } from '../cockpit/model';
import {
  useWorkRecordResult,
  useWorkRecords,
  type IntentHeader,
  type WorkIndexWorkspace,
} from '../hosted-work-index';
import { hostedError } from '../snapshot';
import { useNow } from '../shell/StatusBar';
import { Button, ButtonLink, Panel } from '../ui/primitives';
import { LaneSaves, type SaveFiles } from './LaneSaves';
import { HostedRunDetail } from './HostedRunDetail';
import { CheckPanel } from './CheckPanel';
import { PendingWrite } from '../pending-write';
import { useRef } from 'react';
import { Conversation } from './Conversation';
import { LaneHeader, NextStep, nextStep } from './LaneParts';
import { Feed } from '../cockpit/Feed';
import { WorkDetailLayout, CollapseSideButton } from '../shell/WorkDetailLayout';
import { laneTimeline } from './timeline';
import { laneFacts } from '../ui/lane-facts';

type Records = CockpitWork;

const generic = (name?: string) => !name?.trim() || /^agent workflow$/i.test(name.trim());

/** ⋯ on the Lane header: Copy link, Get code, then the owner lifecycle items. */
function LaneMoreMenu({ head, lifecycle }: { head: string; lifecycle?: ReactNode }) {
  const [message, setMessage] = useState('');
  return (
    <>
      <Menu
        label={<Glyph name="more" size={14} />}
        ariaLabel="More Lane actions"
        className="fx-btn fx-btn-ghost fx-btn-sm fx-more"
      >
        <Button
          variant="ghost"
          onClick={() =>
            void navigator.clipboard.writeText(savedLink(head)).then(
              () => setMessage('Link copied'),
              () => setMessage('Could not copy link. Try again.'),
            )
          }
        >
          Copy link
        </Button>
        <ButtonLink
          variant="ghost"
          href={settingsHref(routeUrlState().searchParams.has('project') ? 'transfer' : 'backups')}
        >
          Get code
        </ButtonLink>
        {lifecycle}
      </Menu>
      <span className="fx-sr" role="status">
        {message === 'Link copied' ? message : ''}
      </span>
      {message.startsWith('Could') && <ErrorToast>{message}</ErrorToast>}
    </>
  );
}

/** Pure hosted Lane on the shared detail layout: next step, check, changes, record | timeline, conversation. */
export function HostedLaneView({
  laneId,
  records,
  sessions,
  events,
  now,
  changes,
  send,
  back,
  lifecycle,
  evidence,
  readSaveFiles,
}: {
  laneId: string;
  records: Records;
  sessions: readonly Session[];
  events: readonly ActivityEvent[];
  now: number;
  changes: ReactNode;
  send?: (text: string) => Promise<boolean>;
  back?: ReactNode;
  lifecycle?: LifecycleParts | null;
  evidence?: ReactNode;
  readSaveFiles?: SaveFiles;
}) {
  const lane = useMemo(
    () => withSessions(cockpitLanes(records), sessions, now).find(item => item.id === laneId),
    [records, sessions, now, laneId],
  );
  const record = records.lanes.find(item => item.id === laneId);
  if (!lane || !record) return null;
  const timeline = laneTimeline(records, laneId, hostedFeed(events, sessions, records.lanes, events.length));
  const href = (section: string, extra: Record<string, string> = {}) => {
    const url = routeUrlState();
    url.searchParams.set('projectTab', section);
    for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
    return url.pathname + url.search;
  };
  const run = lane.viewId ? latestRun(records.runs, lane.viewId) : undefined;
  const candidate = lane.viewId ? records.views.find(view => view.id === lane.viewId) : undefined;
  const lastSave = record.lastCheckpointAt ?? record.checkpoints?.at(-1)?.at;
  const started =
    record.lifecycle?.[0]?.at ?? records.intents.find(intent => intent.id === lane.intentId)?.createdAt;
  const by = lane.session?.name ?? (generic(lane.startedBy?.name) ? undefined : lane.startedBy?.name);
  const saved = !!(record.checkpoints?.length || record.lastCheckpointAt || record.head !== record.base);
  const since = lastSave
    ? `last save ${age(lastSave, now, true)}`
    : started
      ? `started ${age(started, now, true)}`
      : '';
  const step = nextStep(lane, since);
  // The header pill uses the same attention word as the Lane's row (Waiting when nobody holds it).
  const fact = laneFacts(records, [lane], now).get(lane.id);
  const brief = laneBrief(lane, run?.id);
  return (
    <WorkDetailLayout
      className="fx-lane-page"
      crumbs={
        <>
          <Breadcrumbs
            items={[
              { label: lane.intent, href: workHref({ intent: lane.intentId }) },
              { label: lane.name, href: workHref({ lane: lane.id, projectTab: 'lanes' }) },
            ]}
          />
          {back}
        </>
      }
      header={
        <LaneHeader
          lane={fact ? { ...lane, tone: fact.tone, label: fact.label } : lane}
          now={now}
          base={[
            lane.mainIncluded === false
              ? 'From main · needs update'
              : lane.mainIncluded === true
                ? 'From main · up to date'
                : 'From main',
            saved && lane.checkpoints
              ? `${lane.checkpoints} ${lane.checkpoints === 1 ? 'save' : 'saves'}${lastSave ? ` · last save ${age(lastSave, now, true)}` : ''}`
              : '',
          ]
            .filter(Boolean)
            .join(' · ')}
          actions={
            <>
              {lifecycle?.status}
              <CopyPrompt request={brief} label="Hand to an agent" variant="secondary" shortcut />
              <ButtonLink icon="code" href={codeSourceLink(record.head, record.id)}>
                Browse source
              </ButtonLink>
              <LaneMoreMenu head={record.head} lifecycle={lifecycle?.items} />
              {lifecycle?.dialog}
            </>
          }
        />
      }
      next={
        <NextStep
          step={step}
          actions={
            step.nobody ? (
              <>
                <CopyPrompt request={brief} label="Hand to an agent" variant="rec" />
                {send && (
                  <Button size="sm" variant="secondary" onClick={() => void send('Taking this Lane.')}>
                    Take it
                  </Button>
                )}
                {lifecycle?.abandon && (
                  <Button size="sm" variant="ghost" onClick={lifecycle.abandon}>
                    Abandon…
                  </Button>
                )}
              </>
            ) : lane.tone === 'passed' && lane.viewId ? (
              <ButtonLink
                variant="primary"
                size="lg"
                icon="review"
                href={href('intent', {
                  intent: lane.intentId,
                  intentTab: 'delivery',
                  reviewView: lane.viewId,
                  classic: '1',
                })}
              >
                Review &amp; accept
              </ButtonLink>
            ) : undefined
          }
        />
      }
      timelineCount={timeline.length}
      messageCount={events.filter(event => event.command.kind === 'message').length}
      side={
        <>
          <Feed
            {...{ viewHref: hostedViewHref }}
            title="Timeline"
            items={timeline}
            now={now}
            actions={<CollapseSideButton />}
          />
          <Conversation
            draftKey={laneId}
            events={events.filter(event => event.command.kind === 'message' || event.command.kind === 'ack')}
            sessions={sessions}
            now={now}
            {...(send ? { send } : {})}
          />
        </>
      }
    >
      <WorkMap
        now={now}
        compact
        lanes={[lane]}
        views={intentViews(records, lane.intentId).filter(view =>
          view.inputs?.some(input => input.laneId === laneId),
        )}
        laneHref={id => href('lane', { lane: id })}
        viewHref={hostedViewHref}
      />
      <CheckPanel
        run={run ? { ...run, check: run.checkName ?? run.check?.name } : null}
        summary={run?.failureSummary ?? null}
        now={now}
        mainIncluded={lane.mainIncluded}
      >
        {evidence}
      </CheckPanel>
      {saved ? (
        changes
      ) : (
        <Panel title="Changes">
          <p className="fx-panel-empty">
            No saves yet
            {started && ` · started ${age(started, now, true)}`}
            {by && ` by ${by}`}
          </p>
        </Panel>
      )}
      <Panel>
        <LaneSaves
          saves={record.checkpoints ?? []}
          lastSave={
            record.lastCheckpointAt
              ? {
                  head: record.head,
                  at: record.lastCheckpointAt,
                  message: record.lastCheckpointMessage ?? '',
                }
              : undefined
          }
          base={record.base}
          head={record.head}
          now={now}
          readFiles={readSaveFiles}
          candidate={
            candidate ? (
              <>
                <a href={hostedViewHref(candidate.id)}>
                  <code>{candidate.head?.slice(0, 8) ?? candidate.id.slice(0, 8)}</code>
                </a>
                {run && (
                  <span>
                    {(run.checkName ?? run.check?.name)?.trim() || 'Check'}{' '}
                    {checkStatus(run.status).label.toLowerCase()}
                  </span>
                )}
              </>
            ) : (
              <span>none yet</span>
            )
          }
          baseLabel={(() => {
            const move = (records.channelMoves ?? [])
              .filter(
                move => move.channel === 'main' && move.status === 'accepted' && move.head === record.base,
              )
              .at(-1);
            return move
              ? `main${move.at ? ` · accepted ${age(move.at, now, true)}` : ' · accepted source'}`
              : 'Lane starting point';
          })()}
        />
      </Panel>
    </WorkDetailLayout>
  );
}

/** Hosted Lane with live data: Work index records, sessions, the Lane's feed, and messaging. */
export function HostedLane({
  projectId,
  workspace,
  laneId,
  lane: currentLane,
  selectedLane,
  changes,
  back,
}: {
  projectId: Id<'hostedProjects'>;
  workspace: WorkIndexWorkspace;
  laneId: string;
  lane: Lane;
  selectedLane: Lane | null;
  changes: ReactNode;
  back?: ReactNode;
}) {
  const now = useNow();
  const readSource = useAction(api.projectSourceReview.read);
  const readSaveFiles = useCallback<SaveFiles>(
    async save => {
      const result = JSON.parse(
        await readSource({ projectId, backupId: workspace.backupId, base: save.parent, head: save.head }),
      ) as { available: boolean; paths?: { status: string }[] };
      return result.available ? result.paths!.filter(path => path.status !== 'unchanged').length : null;
    },
    [readSource, projectId, workspace.backupId],
  );
  const intents = useWorkRecords<IntentHeader>(projectId, workspace, 'intents');
  const lanes = useWorkRecords<HostedLaneSummary>(projectId, workspace, 'lanes');
  const selectedIntent = useWorkRecordResult<IntentHeader>(
    projectId,
    workspace,
    'intents',
    currentLane.intentId,
  );
  const views = useWorkRecords<HostedViewSummary>(projectId, workspace, 'views');
  const runs = useWorkRecords<HostedRunSummary>(projectId, workspace, 'runs');
  const scopedViews = useWorkRecords<HostedViewSummary>(projectId, workspace, 'views', currentLane.intentId);
  const laneViews = scopedViews.records.filter(view =>
    (view.inputs ?? []).some(input => input.laneId === laneId),
  );
  const latestView = laneViews.filter(view => view.head).sort((a, b) => b.at.localeCompare(a.at))[0];
  const scopedRuns = useWorkRecords<HostedRunSummary>(
    projectId,
    workspace,
    'runs',
    latestView?.id,
    !!latestView,
  );
  const moves = useWorkRecords<WorkData['channelMoves'][number]>(projectId, workspace, 'channelMoves');
  const sessions = usePresenceSessions(projectId);
  const feed = useQuery(api.projectCoordination.feed, {
    projectId,
    laneId,
    paginationOpts: { numItems: 100, cursor: null },
  });
  usePageCritical('Lane', {
    intents: !intents.initialLoading,
    lanes: !lanes.initialLoading,
    views: !views.initialLoading,
    runs: !runs.initialLoading,
    channelMoves: !moves.initialLoading,
    selectedLane: !!currentLane,
    selectedIntent: !selectedIntent.initialLoading,
    scopedViews: !scopedViews.initialLoading,
    scopedRuns: !scopedViews.initialLoading && (!latestView || !scopedRuns.initialLoading),
    conversation: feed !== undefined,
  });
  const publish = useMutation(api.projectCoordination.publish);
  const [error, setError] = useState('');
  const writer = useRef<PendingWrite<
    import('../../../src/coordination-types').CoordinationCommand,
    unknown
  > | null>(null);
  writer.current ??= new PendingWrite(attempt => publish({ projectId, ...attempt }));
  const records = useMemo(
    () => ({
      intents: [
        ...new Map(
          [...intents.records, ...(selectedIntent.header ? [selectedIntent.header] : [])].map(intent => [
            intent.id,
            intent,
          ]),
        ).values(),
      ],
      lanes: [...new Map([...lanes.records, currentLane].map(lane => [lane.id, lane])).values()].map(lane =>
        selectedLane?.id === lane.id && selectedLane.head === lane.head
          ? { ...lane, checkpoints: selectedLane.checkpoints }
          : lane,
      ),
      views: [...new Map([...views.records, ...scopedViews.records].map(view => [view.id, view])).values()],
      runs: [...new Map([...runs.records, ...scopedRuns.records].map(run => [run.id, run])).values()],
      channelMoves: moves.records,
    }),
    [
      intents.records,
      lanes.records,
      selectedLane,
      currentLane,
      selectedIntent.header,
      views.records,
      runs.records,
      scopedViews.records,
      scopedRuns.records,
      moves.records,
    ],
  );
  const send = async (text: string) => {
    setError('');
    try {
      const lane = lanes.records.find(item => item.id === laneId);
      await writer.current!.send({
        kind: 'message',
        text,
        context: { laneId, ...(lane ? { intentId: lane.intentId } : {}) },
      });
      return true;
    } catch (e) {
      setError(hostedError(e));
      return false;
    }
  };
  const laneRecord = records.lanes.find(l => l.id === laneId) ?? currentLane;
  const lifecycle = useOwnerLifecycle({
    projectId,
    collection: 'lanes',
    id: laneId,
    head: laneRecord.head,
    state: laneRecord.state,
    editable: workspace.capabilities.owner,
  });
  const client = useConvex();
  const briefs = useMemo(() => hostedBriefs(client, projectId), [client, projectId]);
  return (
    <BriefSourceContext.Provider value={briefs}>
      <div className="fx">
        {sessions.status !== 'Exhausted' && <p role="status">Reading participant pages…</p>}
        <HostedLaneView
          laneId={laneId}
          readSaveFiles={readSaveFiles}
          lifecycle={lifecycle}
          evidence={(() => {
            const viewId = cockpitLanes(records).find(item => item.id === laneId)?.viewId;
            const run = viewId ? latestRun(records.runs, viewId) : undefined;
            return run ? (
              <HostedRunDetail key={run.id} run={run} projectId={projectId} workspace={workspace} />
            ) : null;
          })()}
          records={records}
          sessions={sessions.results as Session[]}
          events={(feed?.page ?? []) as ActivityEvent[]}
          now={now}
          changes={changes}
          send={send}
          back={
            <>
              {back}
              {error && <ErrorToast>{error}</ErrorToast>}
            </>
          }
        />
      </div>
    </BriefSourceContext.Provider>
  );
}
