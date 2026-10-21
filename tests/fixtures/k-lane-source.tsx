// SPDX-License-Identifier: Apache-2.0
import { browserSource } from './hosted-tree/browser-source.mjs';
import { createRoot } from 'react-dom/client';
import { ToastProvider } from '../../web/src/ui/Toast';
import { HostedLaneChanges } from '../../web/src/lane/HostedLaneChanges';
import '../../web/src/style.css';
const legacy = new URLSearchParams(location.search).has('legacy');
const runtime = globalThis as typeof globalThis & { __forgeTree: unknown; __sourceReads: number };
runtime.__sourceReads = 0;
const source = await browserSource({ empty: {} }, (read: { kind: string }) => {
  if (read.kind === 'state') runtime.__sourceReads++;
});
runtime.__forgeTree = {
  queries: { 'projectWorkIndex:detail': () => ({generationId:'g1', value:null}) },
  mutations: source.mutations,
};
createRoot(document.getElementById('root')!).render(<ToastProvider><HostedLaneChanges
  projectId={'project' as never} backupId={'backup' as never} base={source.heads.empty} head={source.heads.empty}
  workspace={{generationId:'g1',backupId:'backup',sourceKind:'native',sourceTransport:'objects',counts:legacy?{}:{sourcePins:1}} as never}
/></ToastProvider>);
