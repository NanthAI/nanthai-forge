// SPDX-License-Identifier: Apache-2.0
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { ConvexProvider } from 'convex/react';
import { getFunctionName } from 'convex/server';
import { HostedNowView } from '../../../web/src/cockpit/HostedNow';
import { CoordinationContext, useCoordination, useLiveCoordination } from '../../../web/src/cockpit/coordination';
import { useOverlapAnswers } from '../../../web/src/cockpit/overlap-answers';
import { ToastProvider } from '../../../web/src/ui/Toast';
import { overlapNowFixture } from '../../now-overlaps-fixture.mjs';
import { nowOverlapView } from '../../../src/now-overlap-view';
import { firstWriteNoticeId } from '../../../src/now-overlap-signals';
import '../../../web/src/legacy.css';
import '../../../web/src/ui/tokens.css';
import '../../../web/src/shell/shell.css';
import '../../../web/src/ui/components.css';
import '../../../web/src/cockpit/cockpit.css';
import '../../../web/src/cockpit/now.css';
import '../../../web/src/ui/signals.css';
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'light';
const f = overlapNowFixture(params.get('state') ?? 'C');
// Real detections carry the id the detector derives from their sorted Lanes and file; the Now read sends
// detections without ids and the page derives them again, so the fixture uses real ids throughout.
const real = <T extends { noticeId: string; file: string; lanes: string[] }>(notice: T): T => {
  const lanes = [...notice.lanes].sort();
  return { ...notice, lanes, noticeId: firstWriteNoticeId(lanes, notice.file) };
};
for (const lane of f.records.lanes) lane.overlaps = lane.overlaps.map(real);
f.live.overlapSignals.notices = f.live.overlapSignals.notices.map(real);
f.live.overlapAnswers = f.live.overlapAnswers.map((answer: any) => ({ ...answer, noticeId: f.records.lanes.find((lane: any) => lane.id === answer.laneId)!.overlaps[0].noticeId }));
const calls: any[] = [], listeners = new Map<string, Set<() => void>>();
let release: ((fail?: boolean) => void) | undefined;
let answers = [...f.live.overlapAnswers];
// The Now read's reply shape (src/now-overlap-view.ts): answered keys per Lane and the caller's answer times.
const view = (complete: boolean) => JSON.stringify(nowOverlapView(f.live.overlapSignals, answers.map(answer => ({ actor: '', at: '', ...answer })), 'viewer', complete));
let queryValue = view(params.get('partial') !== '1');
const result = (name: string) => name === 'projectHostedOverlapAcks:now' ? queryValue : name === 'projectCoordination:sessions' ? { page: f.live.sessions, isDone: true, continueCursor: '' } : name === 'projectCoordination:recent' ? { page: [], isDone: true, continueCursor: '' } : name === 'projectCoordinationReads:unacked' ? { items: [], complete: true } : name === 'projectCoordinationReads:claims' ? { claims: [] } : { activeAgents: 2, activePeople: 0, activeSubagents: 0, activeLanes: 4, unannouncedActiveLanes: 0 };
const values = new Map<string, any>();
const client = {
  watchQuery(ref: any, args: any) {
    const name = getFunctionName(ref), key = JSON.stringify([name, args]);
    if (!values.has(key)) values.set(key, result(name));
    return { localQueryResult: () => name === 'projectHostedOverlapAcks:now' ? queryValue : values.get(key), journal: () => undefined,
      onUpdate(callback: () => void) { calls.push({ kind: 'subscribe', name, args }); const set = listeners.get(name) ?? new Set(); set.add(callback); listeners.set(name, set); return () => set.delete(callback); } };
  },
  async mutation(ref: any, args: any) {
    const name = getFunctionName(ref); calls.push({ kind: 'mutation', name, args });
    if (name !== 'projectHostedOverlapAcks:append') throw Error(`Unexpected mutation ${name}`);
    await new Promise<void>((resolve, reject) => { release = fail => fail ? reject(Error('Synthetic unavailable')) : resolve(); });
    return JSON.stringify({ status: 'recorded' });
  },
};
function Shared() { const live = useLiveCoordination('synthetic' as any, true); return <CoordinationContext.Provider value={live}><Now /></CoordinationContext.Provider>; }
function Now() {
  const live = useCoordination('synthetic' as any), ack = useOverlapAnswers('synthetic' as any, 'Dino');
  const [, rerender] = useState(0);
  (window as any).__overlaps = { calls, release: (fail = false) => release?.(fail), settle: (addNotice = false) => {
    const last = calls.filter(call => call.kind === 'mutation').at(-1);
    answers.push(...JSON.parse(last.args.request).answers.map((answer: any) => ({ ...answer, actor: 'viewer', at: new Date(f.now).toISOString() })));
    if (addNotice) {
      const lane = f.records.lanes[0];
      const fresh = real({ ...lane.overlaps[0], file: 'src/r2/fresh.ts' });
      lane.overlaps.push(fresh);
      f.live.overlapSignals.notices.push({ ...fresh, laneId: lane.id });
    }
    queryValue = view(true);
    for (const update of listeners.get('projectHostedOverlapAcks:now') ?? []) update();
  }, rerender: () => rerender(n => n + 1) };
  return <div className="fx"><HostedNowView now={f.now} records={f.records} live={live} viewer="viewer" loading={false} ack={{ ...ack, acknowledge: async () => true, reply: async () => true, retrying: () => false }} laneHref={id => `#lane-${id}`} newIntent={() => {}} showFirstRun={false} /></div>;
}
createRoot(document.getElementById('root')!).render(<ConvexProvider client={client as any}><ToastProvider><Shared /></ToastProvider></ConvexProvider>);
