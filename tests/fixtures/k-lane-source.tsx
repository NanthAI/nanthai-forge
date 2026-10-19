// SPDX-License-Identifier: Apache-2.0
import { createRoot } from 'react-dom/client';
import { ToastProvider } from '../../web/src/ui/Toast';
import { HostedLaneChanges } from '../../web/src/lane/HostedLaneChanges';
import '../../web/src/style.css';
const legacy = new URLSearchParams(location.search).has('legacy');
const runtime = globalThis as typeof globalThis & { __forgeTree: unknown; __sourceReads: number };
runtime.__sourceReads = 0;
runtime.__forgeTree = {
  queries: { 'projectWorkIndex:detail': () => ({generationId:'g1', value:null}) },
  actions: { 'projectSourceReview:read': () => { runtime.__sourceReads++; return JSON.stringify({available:true,paths:[]}); } },
};
createRoot(document.getElementById('root')!).render(<ToastProvider><HostedLaneChanges
  projectId={'project' as never} backupId={'backup' as never} base={'a'.repeat(64)} head={'b'.repeat(64)}
  workspace={{generationId:'g1',backupId:'backup',sourceKind:'native',sourceTransport:'objects',counts:legacy?{}:{sourcePins:1}} as never}
/></ToastProvider>);
