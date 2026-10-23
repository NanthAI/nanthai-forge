// SPDX-License-Identifier: Apache-2.0
// Synthetic evidence only: no hosted connection or owner writes.
import { createRoot } from 'react-dom/client';
import { LaneHeader } from '../../web/src/lane/LaneParts';
import { LaneViews } from '../../web/src/views/LaneViews';
import { WorkMap } from '../../web/src/views/WorkMap';
import { Diff } from '../../web/src/lane/Diff';
import { InlineError } from '../../web/src/ui/InlineError';
import { Feed } from '../../web/src/cockpit/Feed';
import { laneTimeline } from '../../web/src/lane/timeline';
import { Panel } from '../../web/src/ui/primitives';
import '../../web/src/legacy.css';
import '../../web/src/ui/tokens.css';
import '../../web/src/ui/components.css';
import '../../web/src/ui/signals.css';
import '../../web/src/shell/shell.css';
import '../../web/src/cockpit/cockpit.css';
import '../../web/src/lane/lane.css';
import '../../web/src/lane/lane-fable.css';
import '../../web/src/lane/diff.css';
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'dark';
const surface = params.get('surface') ?? 'lane';
const title = 'Cockpit UI rebuild';
const items = Array.from({ length: 16 }, (_, i) => ({ viewId: `v${16-i}`, status: i === 0 || i === 2 ? 'accepted' : i === 1 ? 'ready' : 'superseded',
  why: { outcome: title }, inputs: [{ laneId: 'lane', saveIndex: 26-i }], accepted: i === 0 || i === 2 ? [{channel: 'main'}] : [] }));
const source = async () => ({ items });
const lanes = [{id: 'lane', name: title, checkpoints: 27, accepted: true}];
const views = [{ id: 'v', at: '2026-10-16', status: 'clean', lanes: title, accepted: true, inputs: [{laneId:'lane', head:'a', saveIndex:26}] }];
const comparison = { truncated: false, hunks: [{ beforeStart: 40, afterStart: 40, beforeLines: 3, afterLines: 3, lines: [
  {kind:'context',text:'export function filename(project) {'},
  {kind:'removed',text:'  return project.name;'},
  {kind:'added',text:'  return project.filename ?? project.name;'},
  {kind:'context',text:'}'},
] }] };
if (surface === 'review') import('./qa-b-review');
else createRoot(document.getElementById('root')!).render(<div className="fx fx-page fx-lane-page">
  {surface === 'lane' ? <>
    <nav className="fx-crumbs"><a href="#">Now</a> › <a href="#">{title}</a></nav>
    <LaneHeader lane={{...lanes[0],intent:title,open:false,label:'Done',tone:'plain',fact:'1 save. '+title,conflicts:[]} as never} now={Date.now()} base="From main · up to date" />
    <Feed title="Timeline" now={Date.now()} items={laneTimeline({lanes:[{id:'lane',name:title,checkpoints:[{at:new Date().toISOString(),message:'Keep the toolbar compact'}]}],views:[],runs:[]} as never,'lane',[{id:'return',at:new Date().toISOString(),text:title+' · returned source · 152 files',tone:'active',glyph:'sync'}])} />
    <LaneViews laneId="lane" intentHref="?surface=map" viewHref={id=>'#'+id} source={source as never} viewNumber={id=>Number(id.slice(1))} />
  </> : surface === 'map' ? <WorkMap lanes={lanes} views={views as never} laneHref={()=>'#'} viewHref={()=>'#'} title="Composition" compact /> : <>
    <Panel title="filename.ts"><Diff comparison={comparison as never} file="filename.ts" comment={()=>{}} /></Panel>
    <Panel title="Conversation"><InlineError error="Network request failed" write /></Panel>
  </>}
</div>);
