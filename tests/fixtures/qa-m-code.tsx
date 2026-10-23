// SPDX-License-Identifier: Apache-2.0
// Synthetic Work/source responses; the actual Code and WorkMap components run locally.
import { browserSource } from './hosted-tree/browser-source.mjs';
import { createRoot } from 'react-dom/client';
import HostedCode from '../../web/src/HostedCode';
import { WorkMap } from '../../web/src/views/WorkMap';
import '../../web/src/legacy.css';
import '../../web/src/ui/tokens.css';
import '../../web/src/ui/components.css';
import '../../web/src/ui/signals.css';
import '../../web/src/shell/shell.css';
const files = { 'README.md': 'export const filename = "Report.csv";\n', 'src/export.ts': 'export const filename = "Report.csv";\n', 'src/untouched.ts': 'export const filename = "Report.csv";\n' };
const source = await browserSource({ main: files,
  exports: { ...files, 'src/export.ts': 'export const filename = "Report-2.csv";\n' },
  docs: { ...files, 'README.md': 'export const filename = "Report docs.csv";\n' },
});
const head = source.heads.main;
Object.assign(globalThis, { __sourceHeads: source.heads });
const lanes = [
  { id: 'exports', name: 'Export filenames', intentId: 'intent', base: head, head: source.heads.exports, state: 'active', assignment: 'claude-exports' },
  { id: 'docs', name: 'Explain exports', intentId: 'intent', base: head, head: source.heads.docs, state: 'active' },
] as const;
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'dark';
Object.assign(globalThis, { __forgeTree: {
  queries: { 'projectWorkIndex:detail': () => ({ generationId: 'g1', value: JSON.stringify({ head, files: 3 }) }) },
  pages: { 'projectWorkIndex:records': (args: { collection: string }) => args.collection === 'sourceTreePaths'
    ? [{ value: JSON.stringify({ paths: ['README.md', 'src/export.ts', 'src/untouched.ts'] }) }] : [] },
  mutations: source.mutations,
} });
createRoot(document.getElementById('root')!).render(<div className="fx"><main className="fx-page">
  {params.has('map') ? <><h1>Export filenames</h1><WorkMap
    now={Date.parse('2026-10-16T12:00:00Z')}
    lanes={lanes.map((lane, index) => ({ ...lane, checkpoints: index + 1 }))}
    views={[{ id: 'view', at: '2026-10-16T11:00:00Z', lanes: 'Export filenames', check: 'passed', inputs: [{ laneId: 'exports', saveIndex: 0 }, { laneId: 'docs', saveIndex: 1 }] }]}
    laneHref={id => `#${id}`} viewHref={() => '#view'} /> </>
    : <HostedCode projectId={'project' as never} workspace={{ generationId: 'g1', backupId: 'backup', sourceHead: head } as never} head={head} lanes={lanes as never} />}
</main></div>);
