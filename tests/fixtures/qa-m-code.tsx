// SPDX-License-Identifier: Apache-2.0
// Synthetic Work/source responses; the actual Code and WorkMap components run locally.
import { createRoot } from 'react-dom/client';
import HostedCode from '../../web/src/HostedCode';
import { WorkMap } from '../../web/src/views/WorkMap';
import '../../web/src/legacy.css';
import '../../web/src/ui/tokens.css';
import '../../web/src/ui/components.css';
import '../../web/src/ui/signals.css';
import '../../web/src/shell/shell.css';
const head = 'a'.repeat(64);
const lanes = [
  { id: 'exports', name: 'Export filenames', intentId: 'intent', base: head, head: 'b'.repeat(64), state: 'active' },
  { id: 'docs', name: 'Explain exports', intentId: 'intent', base: head, head: 'c'.repeat(64), state: 'active' },
] as const;
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'dark';
Object.assign(globalThis, { __forgeTree: {
  queries: { 'projectWorkIndex:detail': () => ({ generationId: 'g1', value: JSON.stringify({ head, files: 3 }) }) },
  pages: { 'projectWorkIndex:records': (args: { collection: string }) => args.collection === 'sourceTreePaths'
    ? [{ value: JSON.stringify({ paths: ['README.md', 'src/export.ts', 'src/untouched.ts'] }) }] : [] },
  actions: { 'projectSourceReview:read': (args: { file?: string; head: string }) => JSON.stringify(args.file
    ? { available: true, file: { after: { blob: head } }, after: { kind: 'text', text: 'export const filename = "Report.csv";\n', offset: 0, line: 1, nextOffset: null } }
    : { available: true, paths: [{ path: args.head === lanes[0].head ? 'src/export.ts' : 'README.md', status: 'modified' }] }) },
} });
createRoot(document.getElementById('root')!).render(<div className="fx"><main className="fx-page">
  {params.has('map') ? <><h1>Export filenames</h1><WorkMap
    now={Date.parse('2026-10-16T12:00:00Z')}
    lanes={lanes.map((lane, index) => ({ ...lane, checkpoints: index + 1 }))}
    views={[{ id: 'view', at: '2026-10-16T11:00:00Z', lanes: 'Export filenames', check: 'passed', inputs: [{ laneId: 'exports', saveIndex: 0 }, { laneId: 'docs', saveIndex: 1 }] }]}
    laneHref={id => `#${id}`} viewHref={() => '#view'} /> </>
    : <HostedCode projectId={'project' as never} workspace={{ generationId: 'g1', backupId: 'backup', sourceHead: head } as never} head={head} lanes={lanes as never} />}
</main></div>);
