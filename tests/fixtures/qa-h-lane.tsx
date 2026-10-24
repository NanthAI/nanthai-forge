// SPDX-License-Identifier: Apache-2.0
// Synthetic capture of real slice H components; no hosted connections or owner mutations.
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { LaneSaves, type SaveFiles } from '../../web/src/lane/LaneSaves';
import { RunLog } from '../../web/src/lane/RunLog';
import { WorkMap } from '../../web/src/views/WorkMap';
import type { ViewRow } from '../../web/src/intents/IntentDetail';
import { Panel } from '../../web/src/ui/primitives';
import '../../web/src/legacy.css';
import '../../web/src/ui/tokens.css';
import '../../web/src/ui/components.css';
import '../../web/src/ui/signals.css';
import '../../web/src/shell/shell.css';
import '../../web/src/lane/lane.css';
import '../../web/src/lane/lane-fable.css';
const errors: string[] = [];
Object.assign(globalThis, { __qaHErrors: errors });
window.addEventListener('error', event => errors.push(event.message));
const originalError = console.error;
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); originalError(...args); };
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'dark';
const now = Date.parse('2026-10-16T12:00:00Z');
const saves = [
  { message: '', head: 'a'.repeat(64), parent: '0'.repeat(64), at: '2026-10-16T09:00:00Z' },
  { message: 'Keep export filenames readable', head: 'b'.repeat(64), parent: 'a'.repeat(64), at: '2026-10-16T10:00:00Z' },
  { message: 'Preserve accents when the destination folder has a long name', head: 'c'.repeat(64), parent: 'b'.repeat(64), at: '2026-10-16T11:45:00Z' },
];
const readFiles: SaveFiles = async save => save.head.startsWith('b') ? 1 : 3;
const multi = params.get('case') === 'three-lanes';
const lanes = multi ? [
  { id: 'l', name: 'Export filenames', checkpoints: 4 },
  { id: 'paths', name: 'Destination paths', checkpoints: 3 },
  { id: 'format', name: 'Export formatting', checkpoints: 4 },
] : [{ id: 'l', name: 'Export filenames', checkpoints: 6 }];
const states = multi ? ['accepted', 'failed', 'checking', 'ready'] : ['accepted', 'old', 'old', 'failed', 'checking', 'ready'];
const views: ViewRow[] = states.map((state, i) => ({
  id: `${state}-${i}`, at: new Date(now - (states.length - i) * 3600000).toISOString(), status: 'clean',
  lanes: '', checkName: 'verify', accepted: state === 'accepted',
  ...(state === 'accepted' ? { acceptedAt: new Date(now - 6 * 3600000).toISOString() } : {}),
  ...(state === 'old' ? { supersededBy: 'ready-5' } : {}),
  check: state === 'failed' ? 'failed' : state === 'checking' ? 'running' : 'passed',
  inputs: lanes.filter((_, n) => !multi || i === 3 || n !== (i + 1) % 3).map(lane => ({ laneId: lane.id, head: saves[i % 3]!.head, saveIndex: Math.min(i, lane.checkpoints - 1) })),
}));
function Preview() {
  const [output, setOutput] = useState(false);
  const state = params.get('surface') ?? 'lane';
  return <div className="fx"><main className="fx-page" style={{ padding: 16 }}>
    {state === 'lane' ? <><h1>Export filenames</h1><WorkMap now={now} compact lanes={lanes} views={views} laneHref={() => '#lane'} viewHref={id => `#${id}`} /><Panel title="Saves"><LaneSaves saves={saves} base={'0'.repeat(64)} head={'c'.repeat(64)} now={now} readFiles={readFiles} baseLabel="main · accepted 6 h ago" /></Panel></> : state === 'intent' ? <><h1>Readable exports</h1><WorkMap now={now} lanes={lanes} views={views} laneHref={() => '#lane'} viewHref={id => `#${id}`} /></> : <Panel title="verify · Running"><button onClick={() => setOutput(true)}>Simulate streamed output</button><RunLog runId="synthetic-run" status="running" remoteMachine="Owner’s MacBook Pro" read={async () => output ? { offset: 0, nextOffset: 24, bytes: 24, text: '✔ filenames preserved\n', more: false } : { offset: 0, nextOffset: 0, bytes: 0, text: '', more: false, available: false }} /></Panel>}
  </main></div>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
