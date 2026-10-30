// SPDX-License-Identifier: Apache-2.0
import { createRoot } from 'react-dom/client';
import { useMemo, useState } from 'react';
import { ConvexProvider } from 'convex/react';
import { getFunctionName } from 'convex/server';
import { HostedNowView } from '../../../web/src/cockpit/HostedNow';
import { useFixAnswers } from '../../../web/src/cockpit/fix-answers';
import { ToastProvider } from '../../../web/src/ui/Toast';
import '../../../web/src/legacy.css';
import '../../../web/src/ui/tokens.css';
import '../../../web/src/shell/shell.css';
import '../../../web/src/ui/components.css';
import '../../../web/src/cockpit/cockpit.css';
import '../../../web/src/cockpit/now.css';
import '../../../web/src/ui/signals.css';

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'light';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const intentId = id(1), otherIntentId = id(2), fixLane = id(3), audit = id(4), receipt = id(5);
const head = 'b'.repeat(64), now = Date.parse('2026-10-14T10:20:00Z');
const notices = [
  { intentId, state: 'reverted' as const, auditRunId: audit, receiptId: receipt, head,
    summary: `Reverted receipt ${receipt}: tests/r2-range.test.mjs, tests/hosted-source-bytes.test.mjs failed on ${head}`,
    undo: `nforge agent ROOT revert '{"receiptId":"${receipt}"}'` },
  { intentId: otherIntentId, state: 'needs-fix' as const, auditRunId: id(6), head,
    summary: `Fix needed for receipt ${receipt}: tests/http-limits.test.mjs failed on ${head}`,
    undo: `nforge agent ROOT start '{"intentId":"${otherIntentId}"}'` },
];
const calls: { name: string; args: any }[] = [];
let release: (() => void) | undefined;
let fail = false;
const role = params.get('role') ?? 'owner';
const main = { schema: 2, projectId: 'synthetic', snapshotId: 'snapshot', sourceRevision: 1, channel: 'main', head, authority: { mode: 'server', epoch: 1 }, receipt: { id: receipt, kind: 'server', previousHead: null, previousReceiptId: null } };

function App() {
  const [remaining, setRemaining] = useState(notices);
  const client = useMemo(() => ({
    query: async (ref: any, args: any) => {
      calls.push({ name: getFunctionName(ref), args });
      return JSON.stringify(main);
    },
    mutation: async (ref: any, args: any) => {
      const name = getFunctionName(ref);
      calls.push({ name, args });
      if (name === 'projectHostedStart:start') {
        await new Promise<void>(resolve => { release = resolve; });
        if (fail) throw Error('Synthetic unavailable');
        return JSON.stringify({ schema: 1, operationId: args.operationId, intentId: args.intent.intentId, at: '2026-10-14T10:20:00Z', fixBrief: 'Failing tests, diff and undo', lane: { schema: 2, projectId: 'synthetic', laneId: fixLane, intentId: args.intent.intentId, head, version: 0, sourceVersion: 0, lifecycleVersion: 0, state: 'active', base: args.expectedMain, authority: main.authority } });
      }
      if (name === 'projectWorkCommand:command') {
        if (fail) throw Error('Synthetic unavailable');
        const command = JSON.parse(args.command);
        setRemaining(previous => previous.filter(notice => notice.intentId !== command.intentId));
        return {};
      }
      throw Error('Unexpected mutation');
    },
  }), []);
  (window as any).__recovery = { calls, main, release: (error = false) => { fail = error; release?.(); }, setFailure: (value: boolean) => { fail = value; }, reland: () => setRemaining([]) };
  return <ConvexProvider client={client as any}><ToastProvider><Now remaining={remaining} /></ToastProvider></ConvexProvider>;
}
function Now({ remaining }: { remaining: typeof notices }) {
  const ack = useFixAnswers('synthetic' as any);
  return <div className="fx"><HostedNowView now={now} records={{ needsFix: remaining, intents: [{ id: intentId, outcome: 'Faster first byte from R2', status: 'active' }, { id: otherIntentId, outcome: 'Rate limit headers', status: 'active' }], lanes: [], views: [], runs: [] }} live={{ sessions: [], events: [], unacked: [], unackedComplete: true, claims: [], sessionsLoading: false }} loading={false} ack={{ ...ack, acknowledge: async () => true, reply: async () => true, retrying: () => false }} capabilities={{ owner: role === 'owner', intent: role !== 'viewer' }} laneHref={id => `#fix-${id}`} newIntent={() => {}} showFirstRun={false} /></div>;
}
createRoot(document.getElementById('root')!).render(<App />);
