// SPDX-License-Identifier: Apache-2.0
import { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useRepositoryGraph } from '../../web/src/useRepositoryGraph';
import { ActionPanel, PageTabs, useSection } from '../../web/src/WorkspaceUI';
import { importEdges, pinnedPage } from '../../web/src/graph-model';
import { readRoute, type api, type Page, type ImportEdge } from '../../web/src/api';
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
async function settle() {
  await frame();
  await frame();
}
function require(value: unknown, message: string) {
  if (!value) throw new Error(message);
}
const page = (sourceId: string, results: unknown[]) => ({
  sourceId,
  analysisId: 'analysis',
  freshness: 'current',
  results,
  total: results.length,
  truncated: false,
  limitations: [],
});
const pending: { name: string; resolve: (v: unknown) => void }[] = [];
const first = ((path: string) =>
  path.startsWith('graph')
    ? Promise.reject(new Error('Unknown endpoint.'))
    : path.startsWith('files')
      ? new Promise(resolve => pending.push({ name: 'first', resolve }))
      : Promise.resolve(page('A', [{ from: 'A.ts', target: 'B.ts', resolution: 'resolved' }]))) as typeof api;
const second = ((path: string) =>
  path.startsWith('graph')
    ? Promise.resolve({
        files: page('B', [{ path: 'B.ts', bytes: 2, digest: 'B' }]),
        relationships: page('B', []),
      })
    : Promise.reject(new Error('Combined graph must not make per-file reads'))) as typeof api;
let observed: ReturnType<typeof useRepositoryGraph>,
  change: (source: string) => void,
  selectFile: (file: string) => void,
  next: (s: 'one' | 'two') => void;
let violations = 0,
  accidentalSubmissions = 0;
function Probe() {
  const [scope, setScope] = useState('A'),
    [file, setFile] = useState('');
  const result = useRepositoryGraph({
    request: scope === 'A' ? first : second,
    sourceId: scope,
    analysisId: 'analysis',
    file,
    initial: null,
  });
  change = s => flushSync(() => setScope(s));
  selectFile = f => flushSync(() => setFile(f));
  const [section, setSection] = useSection('checkTab', ['one', 'two'] as const, 'one');
  next = s => flushSync(() => setSection(s));
  useLayoutEffect(() => {
    observed = result;
    if (scope === 'B' && result.nodes.some(n => n.id === 'A.ts')) violations++;
  });
  return (
    <>
      <p>{result.nodes.map(n => n.id).join(',')}</p>
      <PageTabs
        label="Test destinations"
        value={section}
        onChange={setSection}
        items={[
          { id: 'one', label: 'One' },
          { id: 'two', label: 'Two' },
        ]}
      />
      <div hidden={section !== 'one'}>
        <form
          id="draft-form"
          onSubmit={event => {
            event.preventDefault();
            accidentalSubmissions++;
          }}
        >
          <ActionPanel title="Draft">
            <input aria-label="Draft content" defaultValue="Keep this draft" required />
          </ActionPanel>
        </form>
      </div>
      <div hidden={section !== 'two'}>Second destination</div>
    </>
  );
}
async function run() {
  await settle();
  require(pending.length === 1, 'Initial graph request missing');
  pending.shift()!.resolve(page('A', [{ path: 'A.ts', bytes: 1, digest: 'A' }]));
  await settle();
  require(observed.nodes.length === 2 && observed.edges.length === 1, 'Resolved target missing');
  selectFile('B.ts');
  await settle();
  require(pending.length === 0 && observed.edges.length === 1, 'Selection refetched or erased graph');
  const launcher = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    button => button.textContent === 'Draft',
  )!;
  launcher.click();
  await settle();
  const input = document.querySelector<HTMLInputElement>('[aria-label="Draft content"]')!,
    dialog = input.closest('dialog')!;
  require(dialog.open && accidentalSubmissions === 0, 'Opening task submitted its parent form');
  require(input.form?.id === 'draft-form', 'Portaled input lost its original form owner');
  dialog.querySelector<HTMLButtonElement>('[aria-label="Close panel"]')!.click();
  await settle();
  require(!dialog.open && document.activeElement === launcher, 'Closing task lost trigger focus');
  input.value = '';
  require(!input.form!.checkValidity(), 'Required input was excluded from native validation');
  await settle();
  require(dialog.open, 'Invalid task field could not be reached');
  input.value = 'Keep this draft';
  next('two');
  await settle();
  require(!dialog.open, 'Hidden destination left its task open');
  require((document.querySelector('[aria-label="Draft content"]') as HTMLInputElement).value ===
    'Keep this draft', 'Draft lost across destination');
  history.back();
  await settle();
  await settle();
  require(document.querySelector('[aria-current="page"]')?.textContent ===
    'One', 'Back did not restore destination');
  observed.retry();
  await settle();
  require(pending.length === 1, 'Retry request missing');
  selectFile('');
  change('B');
  await settle();
  require(observed.nodes[0]?.id === 'B.ts', 'New provider did not load');
  pending.shift()!.resolve(page('A', [{ path: 'A.ts', bytes: 1, digest: 'A' }]));
  await settle();
  require(violations === 0 &&
    observed.nodes.every(n => n.id !== 'A.ts'), 'Late old-provider results crossed source boundary');
  for (const patch of [{ sourceId: 'wrong' }, { analysisId: 'wrong' }, { freshness: 'stale' }]) {
    let rejected = false;
    try {
      pinnedPage({ ...page('A', []), ...patch } as Page<unknown>, 'A', 'analysis');
    } catch {
      rejected = true;
    }
    require(rejected, 'Mixed graph provenance accepted');
  }
  const edges = importEdges([
    { from: 'a', target: 'b', resolution: 'resolved' },
    { from: 'a', target: 'b', resolution: 'resolved' },
    { from: 'a', target: 'c', resolution: 'unresolved' },
  ] as ImportEdge[]);
  require(edges.length === 1 && edges[0].to === 'b', 'Invented or duplicate relationship');
  require(readRoute().view === 'map', 'First visit does not lead to graph');
}
function Check() {
  const [message, setMessage] = useState('Ready'),
    [started, start] = useState(false);
  return (
    <main>
      <h1>Forge graph journey check</h1>
      <Probe />
      <button
        disabled={started}
        onClick={() => {
          start(true);
          void run()
            .then(() =>
              setMessage(
                'PASS · graph selection stability, source/provider races, provenance, task focus/form ownership, draft retention, browser Back and graph-first route',
              ),
            )
            .catch(e => setMessage(`FAIL · ${e.message}`));
        }}
      >
        Run check
      </button>
      <p role="status">{message}</p>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Check />);
