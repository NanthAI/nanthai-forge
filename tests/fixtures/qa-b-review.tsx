// SPDX-License-Identifier: Apache-2.0
// Explicit synthetic local evidence for the real HostedReview component, without a backend.
import { createRoot } from 'react-dom/client';
import { HostedReview } from '../../web/src/review/HostedReview';
import '../../web/src/legacy.css';
import '../../web/src/ui/tokens.css';
import '../../web/src/ui/components.css';
import '../../web/src/ui/signals.css';
import '../../web/src/shell/shell.css';
import '../../web/src/lane/lane.css';
import '../../web/src/lane/lane-fable.css';
import '../../web/src/lane/review.css';
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'dark';
const state = params.get('state') ?? 'ready';
const at = new Date(Date.now() - 300000).toISOString();
const view = { id: '11111111-1111-4111-a111-111111111111', intentId: '22222222-2222-4222-a222-222222222222',
  base: 'b'.repeat(64), head: 'a'.repeat(64), status: 'clean', inputs: [], at, main: { head: 'b'.repeat(64), included: true } };
const outcome = 'Preserve the customer export filename when a very long project name contains accents, spaces and a renamed destination folder';
const story = { ...view, status: 'ready', accepted: [], supersededBy: null,
  why: { outcome, notes: [] }, files: { items: [], total: 0, nextCursor: null }, runs: [] };
const request = ['requested', 'waiting', 'accepted', 'rejected'].includes(state) ? {
  state: state === 'waiting' ? 'requested' : state,
  receipt: state === 'accepted' ? JSON.stringify({ status: 'accepted', acceptance: { id: 'synthetic-receipt', viewId: view.id, head: view.head } }) :
    state === 'rejected' ? JSON.stringify({ status: 'rejected', reason: 'Needs re-check: main moved and changed paths overlap the requested View.' }) : null,
} : null;
Object.assign(globalThis, { __forgeTree: { pages: {}, queries: {
  'projectWorkIndex:detail': () => ({ generationId: 'synthetic', value: JSON.stringify({ id: view.intentId, outcome }), editable: true }),
  'projectViewReads:read': () => JSON.stringify(story),
  'projectAutonomy:read': () => ({ acceptance: { protectedPaths: [] } }),
  'projectCoordinationReads:claims': () => ({ claims: [] }),
  'ownerAcceptance:status': (args) => ({ native: true, mainHead: view.base, request: args.channel === 'recheck' ? null : request,
    machine: state === 'requested' || state === 'ready' ? null : { name: 'Maya’s MacBook Pro', lastSeen: Date.now(), command: 'nforge host SYNTHETIC_OWNER --listen' } }),
}, mutations: { 'ownerAcceptance:request': async (args) => { (globalThis.__forgeRequests ??= []).push(args); return { state: 'requested' }; } }, actions: { 'projectViewActions:read': () => JSON.stringify(story) } } });
createRoot(document.getElementById('root')!).render(<HostedReview projectId={'synthetic-project' as never}
  workspace={{ generationId: 'synthetic', revision: 1 } as never} view={view as never}
  channels={[]} owner editable busy={false} lanes={[]} views={[view] as never} act={async () => null} />);
