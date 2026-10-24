// SPDX-License-Identifier: Apache-2.0
// Real changed views, synthetic evidence, no network authority or owner writes.
import { createRoot } from 'react-dom/client';
import { s16Work, s16Notice, now } from './s16-work.mjs';
import { pendingStatus } from '../../src/pending-status';
import { queueFacts } from '../../web/src/cockpit/queue-model';
import { cockpitLanes, byAttention } from '../../web/src/cockpit/model';
import { laneDecisions } from '../../web/src/cockpit/attention';
import { intentRows } from '../../web/src/intents/model';
import { intentViews } from '../../web/src/views/intent-views';
import { IntentDetailView } from '../../web/src/intents/IntentDetail';
import { HostedLaneView } from '../../web/src/lane/HostedLane';
import { HostedNowView } from '../../web/src/cockpit/HostedNow';
import { Activity } from '../../web/src/cockpit/Activity';
import { ChannelStrip } from '../../web/src/shell/StatusBar';
import { Panel } from '../../web/src/ui/primitives';
import { AttentionContext } from '../../web/src/shell/attention-context';
import '../../web/src/ui/tokens.css';
import '../../web/src/ui/components.css';
import '../../web/src/ui/signals.css';
import '../../web/src/shell/shell.css';
import '../../web/src/cockpit/cockpit.css';
import '../../web/src/cockpit/now.css';
import '../../web/src/lane/lane.css';
import '../../web/src/lane/lane-fable.css';
import '../../web/src/cockpit/activity.css';
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'light';
const work = s16Work();
const notices = [s16Notice(work), { ...s16Notice(work, 'historical'), noticeId: 'old-notice', evidence: [{ kind: 'check', runId: 'old-run', viewId: 'old-candidate', status: 'failed' }] }];
const pending = pendingStatus(work, { landingWorker: { status: params.get('owner') === 'stale' ? 'stopped' : 'driving', workers: 1, observedAt: '2026-10-23T19:49:00Z', code: null } }, new Date(now).toISOString());
const queue = queueFacts(pending, notices, new Map([['review', { head: work.lanes.find(lane => lane.id === 'review').head, summary: 'Per-run Modal cost and submission latency recorded in status cost history; totals in the making-of.' }]]));
const records = { ...work, pendingStatus: pending, repairNotices: notices };
const lanes = byAttention(cockpitLanes(records, queue));
const decisions = laneDecisions(lanes);
const href = (id: string) => `?surface=lane&lane=${id}&theme=${params.get('theme') ?? 'light'}`;
const surface = params.get('surface') ?? 'now';
const live = { sessions: [], events: [], unacked: [], claims: [], unackedComplete: true, sessionsLoading: false };
const ack = { busy: null, error: '', retrying: () => false, acknowledge: async () => true, reply: async () => true };
localStorage.setItem('forge.now.seen:s16-preview', String(now - 9 * 3600000));
createRoot(document.getElementById('root')!).render(<AttentionContext.Provider value={{ lanes, queue, pending, notices, decisions, overlaps: [] }}><div className="fx" style={{ minHeight: '100vh', padding: 16 }}>
  <ChannelStrip head={'a'.repeat(64)} at="2026-10-23T19:40:00Z" check="passed" queue={pending} live="Live" />
  {surface === 'lane' ? <HostedLaneView laneId={params.get('lane') ?? 'failed'} records={records} sessions={[]} events={[]} now={now} changes={<Panel title="Changes"><p className="fx-panel-note">3 files</p></Panel>} /> : surface === 'intent' ? <IntentDetailView row={intentRows(records.intents, lanes)[0]!} views={intentViews(records, 'intent')} records={records} notes={[]} planning={[]} now={now} laneHref={href} reviewHref={id => `#${id}`} /> : surface === 'activity' ? <Activity items={[...queue.values()].flatMap(fact => fact.events)} decisions={decisions.length} now={now} nowHref="?surface=now" laneHref={href} viewHref={id => `#${id}`} /> : <HostedNowView records={records} live={live} now={now} loading={false} ack={ack} newIntent={() => {}} laneHref={href} project="s16-preview" showFirstRun={false} />}
</div></AttentionContext.Provider>);
