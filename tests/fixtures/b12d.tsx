// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ToastProvider, useToast } from '../../web/src/ui/Toast';
import { LandingDecision, type LandingDecisionProps } from '../../web/src/lane/LandingDecision';
import { ReviewCheck } from '../../web/src/lane/ReviewCheck';
import { Panel, StatusPill, ExactRecord } from '../../web/src/ui/primitives';
import { landingState, landingRunSummary } from '../../web/src/lane/landing-model';
// @ts-expect-error Local synthetic fixture shared with Node component tests.
import { variantProps, landingRead } from './landing-review.mjs';
import '../../web/src/ui/tokens.css';
import '../../web/src/ui/components.css';
import '../../web/src/ui/signals.css';
import '../../web/src/cockpit/cockpit.css';
import '../../web/src/lane/lane.css';
import '../../web/src/lane/review.css';
import './b12d.css';
const query = new URLSearchParams(location.search);
document.documentElement.dataset.theme = query.get('theme') ?? 'light';
function Fixture() {
  const name = query.get('state') ?? '01-ready';
  const toast = useToast();
  useEffect(() => { if (name === '03-landed') toast.show({ message: 'Accepted · Faster first byte from R2 landed on main', tone: 'success', accepted: true }); }, [name, toast]);
  const [read, setRead] = useState(variantProps(name).read), [reverse, setReverse] = useState(variantProps(name).reverseRead);
  const props = variantProps(name) as LandingDecisionProps;
  const state = landingState(read, Boolean(props.replacement));
  const run = read?.run;
  return <div className="fx fx-app"><header className="fixture-top"><b>NanthAi:Forge</b><span>nanthai-forge</span><a href="#">Now</a><a href="#">Work</a><a href="#">Code</a><a href="#">Settings</a></header>
    <div className="fixture-channel">main · accepted 12 min ago by Dino · ✓ passing</div>
    <main className="fx-page fx-review-page"><nav className="fx-crumbs">Work › Faster first byte from R2 › Review</nav>
      <div className="fx-review-head"><StatusPill tone={state.tone}>{state.label}</StatusPill>{reverse?.request.observation.state === 'landed' && <span className="fx-rev-tag">Reverted by Candidate 5</span>}<h1>Faster first byte from R2</h1><div className="fx-lane-meta"><span>Candidate 4 · 2 Lanes · 14 files · into <b>main</b></span></div></div>
      <div className="fx-review-grid"><div className="fx-lane-col"><Panel title="What this does and why"><div className="fixture-copy">“Serve the first browser byte directly from R2, keeping retries correct.”<p className="fx-faint">Intent · Dino</p></div></Panel>
        <Panel title="Changes, in the order they were built"><div className="fx-review-groups">{['Read browser bytes from R2','Retry short uploads without losing Range headers'].map((text,index)=><button key={text} aria-pressed={index===0}><span className="fx-review-number">{index+1}</span><div className="fx-review-purpose"><b>{text}</b><small>{index===0?'src/r2/bytes.ts · tests/r2-bytes.test.mjs':'src/r2/upload.ts · tests/r2-upload.test.mjs'}</small><small>{index===0?'R2 browser bytes · Codex':'Upload retry · Claude'}</small></div><span className="fx-faint">save {index===0?7:3}</span><span>{index===0?9:5} files</span></button>)}</div></Panel>
        <Panel title="Candidate changes"><div className="fixture-diff"><div>src/r2/bytes.ts</div><pre><span>  export async function browserBytes(request) {'{'}</span>{'\n'}<span className="fixture-del">−   return proxy(request);</span>{'\n'}<span className="fixture-add">+   return readR2(request, request.headers.get('range'));</span>{'\n'}<span>  {'}'}</span></pre></div></Panel></div>
        <aside className="fx-lane-col fx-review-side"><LandingDecision {...props} read={read} reverseRead={reverse} accept={()=>setRead(landingRead('queued'))} cancel={()=>setRead(landingRead('queued',{request:{id:'cancelled',error:{code:'LANDING_CANCELLED',message:'Landing cancelled'},at:'2026-10-26T10:32:00Z',phase:'terminal-failed',observation:{state:'terminal-failed',cause:'rejected',pendingReason:null}}}))} revert={()=>setReverse(landingRead('checking'))} />
          <ReviewCheck run={run ? landingRunSummary(run) : { id:'verify',main:{head:null,included:null},head:'checked',viewId:'candidate',status:'passed',checkId:'check',checkName:'verify',startedAt:'2026-10-26T10:29:00Z',endedAt:'2026-10-26T10:32:12Z',exitCode:0,cause:undefined }} head={run?.request.expectedHead ?? 'checked'} />
          <Panel title="Conversation"><div className="fixture-copy"><b>Codex</b><p>Ready for review. Byte-range and retry tests pass on this Candidate.</p></div></Panel>
          <details className="fx-panel"><summary>Line comments</summary><p className="fixture-copy">No line comments.</p></details><Panel title="Hand to an agent"><div className="fixture-copy"><button className="fx-btn">Copy prompt</button></div></Panel>
          <Panel><ExactRecord open={state.kind==='landed'} rows={[["Candidate","Candidate fixture"],["Main transition","7c1e92a → b31e4a0"]]} /></Panel>
        </aside></div></main></div>;
}
createRoot(document.getElementById('root')!).render(<ToastProvider><Fixture /></ToastProvider>);
