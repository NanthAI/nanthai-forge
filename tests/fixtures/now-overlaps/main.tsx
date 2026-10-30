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
const calls: any[] = [], listeners = new Map<string, Set<() => void>>();
let release: ((fail?: boolean) => void) | undefined;
let answers = [...f.live.overlapAnswers];
let queryValue = JSON.stringify({ page: answers, isDone: params.get('partial') !== '1', signals: f.live.overlapSignals });
const result = (name: string) => name === 'projectHostedOverlapAcks:list' ? queryValue : name === 'projectCoordination:sessions' ? { page: f.live.sessions, isDone: true, continueCursor: '' } : name === 'projectCoordination:recent' ? { page: [], isDone: true, continueCursor: '' } : name === 'projectCoordinationReads:unacked' ? { items: [], complete: true } : name === 'projectCoordinationReads:claims' ? { claims: [] } : { activeAgents: 2, activePeople: 0, activeSubagents: 0, activeLanes: 4, unannouncedActiveLanes: 0 };
const values = new Map<string, any>();
const client = {
  watchQuery(ref: any, args: any) {
    const name = getFunctionName(ref), key = JSON.stringify([name, args]);
    if (!values.has(key)) values.set(key, result(name));
    return { localQueryResult: () => name === 'projectHostedOverlapAcks:list' ? queryValue : values.get(key), journal: () => undefined,
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
      const fresh = { ...lane.overlaps[0], noticeId: 'e'.repeat(64), file: 'src/r2/fresh.ts' };
      lane.overlaps.push(fresh);
      f.live.overlapSignals.notices.push({ ...fresh, laneId: lane.id });
    }
    queryValue = JSON.stringify({ page: answers, isDone: true, signals: f.live.overlapSignals });
    for (const update of listeners.get('projectHostedOverlapAcks:list') ?? []) update();
  }, rerender: () => rerender(n => n + 1) };
  return <div className="fx"><HostedNowView now={f.now} records={f.records} live={live} viewer="viewer" loading={false} ack={{ ...ack, acknowledge: async () => true, reply: async () => true, retrying: () => false }} laneHref={id => `#lane-${id}`} newIntent={() => {}} showFirstRun={false} /></div>;
}
createRoot(document.getElementById('root')!).render(<ConvexProvider client={client as any}><ToastProvider><Shared /></ToastProvider></ConvexProvider>);
