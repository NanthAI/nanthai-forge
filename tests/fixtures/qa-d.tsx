// SPDX-License-Identifier: Apache-2.0
// Synthetic data through the real hosted project tree; no network or credentials.
import { browserSource } from './hosted-tree/browser-source.mjs';
import { createRoot } from 'react-dom/client';
const PROJECT='project-under-test';
(globalThis as any).__qaErrors=[];
addEventListener('error',event=>(globalThis as any).__qaErrors.push(event.message));
import { HostedFrame } from '../../web/src/shell/HostedFrame';
import ProjectBackups from '../../web/src/ProjectBackups';
import { installRoutes } from '../../web/src/shell/location';
import '../../web/src/legacy.css';
import '../../web/src/legacy-hosted.css';
import '../../web/src/ui/tokens.css';
import '../../web/src/ui/components.css';
import '../../web/src/ui/signals.css';
import '../../web/src/shell/shell.css';
import '../../web/src/shell/hosted-frame.css';
import '../../web/src/cockpit/cockpit.css';
import '../../web/src/cockpit/now.css';
import '../../web/src/cockpit/activity.css';
import '../../web/src/cockpit/delegate.css';
import '../../web/src/lane/lane.css';
import '../../web/src/lane/diff.css';
import '../../web/src/lane/lane-fable.css';
import '../../web/src/intents/intents.css';
import '../../web/src/planning.css';
const data=(globalThis as any).__qaData;
const f={intentId:data.intentId};
const tree:any={viewer:{id:'viewer',fullName:'Test Viewer'},queries:{},pages:{},actions:{}};
const now=Date.now();
const time=(minutes:number)=>new Date(now-minutes*60000).toISOString();
const collections=data.collections;
for (const collection of Object.values(collections)) for (const row of collection) {
  const value = JSON.parse(row.value);
  if (value.outcome) value.outcome = 'Keep file navigation clear';
  if (value.name === 'summary-lane') value.name = 'File navigation';
  if (value.status === 'failed') {value.status='passed';value.exitCode=0;delete value.failureSummary;}
  if (value.createdAt) value.createdAt=time(20);
  if (value.at) value.at=time(5);
  if (value.lastCheckpointAt) value.lastCheckpointAt=time(7);
  if (value.startedAt) value.startedAt=time(6);
  if (value.endedAt) value.endedAt=time(5);
  if (value.lastCheckpointMessage) value.lastCheckpointMessage='Keep file navigation clear';
  row.value=JSON.stringify(value);
}
collections.lanes.push({id:'done-lane',position:1,value:JSON.stringify({...JSON.parse(collections.lanes[0].value),id:'done-lane',state:'completed',name:'Completed cleanup'})});
const oldMessage = {operationId:'stale-question',actor:'viewer',actorDisplayName:'Project owner',recipientActor:'viewer',at:now-60000,command:{kind:'message',sessionId:'gpt-done-session',text:'This stale question must leave Needs you.',context:{laneId:'done-lane'}}};
const sessions = [{sessionId:'gpt-done-session',name:'gpt-done',kind:'agent',status:'completed',environment:'Local Lane',context:{laneId:'done-lane'},lastSeen:now-60000,summary:'Completed cleanup'}];
const workspace = data.workspace;
workspace.sourceKind='native';workspace.sourceTransport='objects';workspace.counts={intents:1,lanes:2,views:1};
const project=data.project;
const empty: unknown[]=[];
const checkpoints=[{id:'backup-older',status:'stored',at:now-120000,size:1024,digest:'d'.repeat(64),preview:{lanes:2,files:24,channels:[],format:'native',revision:1,head:'b'.repeat(64),intents:1,views:1,runs:1,unavailable:0}}];
Object.assign(tree.queries, {
  'projectWork:state':()=>project,
  'projectContributors:list':()=>[],
  'projectWorkIndex:workspace':()=>JSON.stringify(workspace),
  'projectWorkIndex:detail':(args: {collection:string;id:string})=>({generationId:'g1',revision:1,value:collections[args.collection]?.find(row=>row.id===args.id)?.value??null,editable:true,intentPin:null}),
  'projectCoordinationReads:unacked':()=>({items:[oldMessage],complete:true}),
  'projectCoordination:counts':()=>({activeAgents:0,activeSubagents:0,activePeople:0,activeLanes:0,unannouncedActiveLanes:0}),
  'projectWork:sourceTransport':()=>({backupId:'backup-1',digest:workspace.backupDigest,transport:'objects'}),
});
Object.assign(tree.pages, {
  'projectWorkIndex:records':(args:{collection:string})=>collections[args.collection]??empty,
  'projectBackups:list':()=>[project],
  'projectBackups:history':()=>checkpoints,
  'projectCoordination:sessions':()=>sessions,
  'projectCoordination:recent':()=>[oldMessage],
});
const sourceFiles = Object.fromEntries(['README.md','src/index.ts','src/navigation.ts','web/src/App.tsx']
  .map(path => [path, 'export const project = "Forge";\n']));
const sourceHeads = new Set<string>([workspace.sourceHead]);
const collectHeads = (value: any, key = '') => {
  if (typeof value === 'string' && /^(head|base|parent|sourceHead|nativeHead)$/.test(key) && /^[a-f0-9]{64}$/.test(value)) sourceHeads.add(value);
  else if (Array.isArray(value)) value.forEach(item => collectHeads(item));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([key, value]) => collectHeads(value, key));
};
collectHeads(workspace); collectHeads(project); collectHeads(checkpoints);
for (const rows of Object.values(collections)) for (const row of rows) collectHeads(JSON.parse(row.value));
const source = await browserSource(Object.fromEntries([...sourceHeads].map(head => [head, sourceFiles])));
const remapHeads = (value: any): any => typeof value === 'string' ? source.heads[value] ?? value
  : Array.isArray(value) ? value.map(remapHeads)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, value]) => [key, remapHeads(value)])) : value;
Object.assign(workspace, remapHeads(workspace)); Object.assign(project, remapHeads(project));
for (const checkpoint of checkpoints) Object.assign(checkpoint, remapHeads(checkpoint));
for (const rows of Object.values(collections)) for (const row of rows) {
  const value = JSON.stringify(remapHeads(JSON.parse(row.value)));
  Object.assign(row, remapHeads({ ...row, value: null }), { value });
}
tree.mutations = source.mutations;
tree.actions['projectPeopleActions:labels']=()=>[];
(globalThis as any).__forgeTree=tree;
const params=new URLSearchParams(location.search);
document.documentElement.dataset.theme=params.get('theme')??'dark';
localStorage.setItem('forge-theme',params.get('theme')??'dark');
const surface=params.get('qaSurface')??'work';
const url=new URL(location.href);
url.searchParams.set('project',PROJECT);
url.searchParams.set('projectTab',surface==='transfer'?'transfer':surface==='code'?'delivery':surface==='now'?'overview':'intent');
if(surface==='transfer')url.searchParams.set('settingsSection','transfer');
if(surface==='intent')url.searchParams.set('intent',f.intentId);
history.replaceState(null,'',url);
installRoutes(true);
createRoot(document.getElementById('root')!).render(<HostedFrame identity surface="projects" setSurface={()=>{}}><ProjectBackups /></HostedFrame>);
