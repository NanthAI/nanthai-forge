import { SourcePicker } from '../../web/src/shell/SourcePicker';
import { currentSource, sourceOptions } from '../../web/src/shell/source-options';
// SPDX-License-Identifier: Apache-2.0
// Synthetic records, production detail views and primitives. No hosted credentials or writes.
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { Shell } from '../../web/src/shell/Shell';
import { Breadcrumbs, workHref } from '../../web/src/shell/Breadcrumbs';
import { Menu } from '../../web/src/ui/Menu';
import { Button } from '../../web/src/ui/primitives';
import { LifecycleDialog } from '../../web/src/lane/LifecycleDialog';
import { ObjectActions, codeSourceLink } from '../../web/src/shell/ObjectActions';
import { HostedLaneView } from '../../web/src/lane/HostedLane';
import { IntentDetailView } from '../../web/src/intents/IntentDetail';
import { intentRows } from '../../web/src/intents/model';
import { cockpitLanes } from '../../web/src/cockpit/model';
import { ViewPage } from '../../web/src/views/ViewPage';
import type { ReadSource } from '../../web/src/views/model';
import { WorkPlanning } from '../../web/src/WorkPlanning';
import { useSection } from '../../web/src/WorkspaceUI';
import { navigate } from '../../web/src/ui/navigation';
import '../../web/src/ui/tokens.css';
import '../../web/src/ui/components.css';
import '../../web/src/shell/shell.css';
import '../../web/src/shell/search.css';
import '../../web/src/intents/intents.css';
import '../../web/src/cockpit/cockpit.css';
import '../../web/src/lane/lane.css';
import '../../web/src/lane/lane-fable.css';
import '../../web/src/cockpit/delegate.css';
import '../../web/src/planning.css';
const head = 'b'.repeat(64),
  base = 'a'.repeat(64),
  at = new Date(Date.now() - 600000).toISOString();
const records = {
  intents: [
    {
      id: 'intent-a',
      outcome: 'Improve invoice rounding for international invoices',
      status: 'active' as const,
      constraints: '',
      base,
      notes: [],
      createdAt: at,
    },
  ],
  lanes: [
    {
      id: 'lane-a',
      intentId: 'intent-a',
      name: 'Invoice rounding and decimal precision',
      state: 'active' as const,
      base,
      head,
      assignment: 'Synthetic agent',
      target: '',
      checkpoints: [{ head, parent: base, at, message: 'Handle decimal rounding' }],
    },
  ],
  views: [],
  runs: [],
};
const sources = sourceOptions({
  main: base,
  now: Date.now(),
  lanes: records.lanes.map(lane => ({ ...lane, lastCheckpointAt: at })),
  views: [],
  intents: records.intents,
  moves: [],
  runs: [],
});
const source: ReadSource = async () => ({
  viewId: 'view-a',
  intentId: 'intent-a',
  base,
  head,
  at,
  inputs: [{ laneId: 'lane-a', head, saveIndex: 0 }],
  dependencies: [],
  status: 'ready',
  sourceStatus: 'clean',
  supersededBy: null,
  accepted: [],
  why: { intentId: 'intent-a', outcome: records.intents[0].outcome },
  whyIntentIds: ['intent-a'],
  files: { items: [], total: 0 },
  runs: [],
});
function Fixture() {
  const [section] = useSection(
    'surface',
    ['lane', 'intent', 'view', 'review', 'file', 'planning', 'menus'] as const,
    'lane',
  );
  const [tab, choose] = useSection('intentTab', ['summary', 'changes', 'discussion'] as const, 'summary');
  const [dialog, setDialog] = useState<'complete' | 'abandon' | null>(null);
  const [reason, setReason] = useState('');
  const [saveFirst, setSaveFirst] = useState(false),
    [cascade, setCascade] = useState(false);
  const [selected, select] = useState('');
  const lifecycle = (
    <Menu label="Lifecycle">
      <Button onClick={() => setDialog('complete')}>Mark complete</Button>
      <Button data-destructive onClick={() => setDialog('abandon')}>
        Abandon…
      </Button>
    </Menu>
  );
  const crumbs = (
    <Breadcrumbs
      items={[
        { label: records.intents[0].outcome, href: workHref({ intent: 'intent-a' }) },
        { label: records.lanes[0].name, href: workHref({ lane: 'lane-a' }) },
        ...(section === 'review'
          ? [{ label: 'Review', href: location.href }]
          : section === 'file'
            ? [{ label: 'src/invoice.ts', href: location.href }]
            : []),
      ]}
    />
  );
  return (
    <Shell
      context="Synthetic QA project"
      current={section === 'file' ? 'code' : 'work'}
      accountName="Forge Viewer"
      tabs={[
        { id: 'now', label: 'Now', glyph: 'now' },
        { id: 'work', label: 'Work', glyph: 'intent' },
        { id: 'code', label: 'Code', glyph: 'code' },
        { id: 'settings', label: 'Settings', glyph: 'settings' },
      ]}
      onTab={() => {}}
    >
      {section === 'lane' ? (
        <HostedLaneView
          laneId="lane-a"
          records={records}
          sessions={[]}
          events={[]}
          now={Date.now()}
          lifecycle={lifecycle}
          changes={<p>src/invoice.ts · 4 additions, 2 deletions</p>}
        />
      ) : section === 'intent' ? (
        <IntentDetailView
          row={intentRows(records.intents, cockpitLanes(records))[0]}
          views={[]}
          notes={[]}
          planning={[]}
          now={Date.now()}
          laneHref={id => workHref({ lane: id })}
          viewHref={id => workHref({ viewId: id })}
          base={base}
          back={
            <Breadcrumbs
              items={[{ label: records.intents[0].outcome, href: workHref({ intent: 'intent-a' }) }]}
            />
          }
          setStatus={async () => null}
          more={lifecycle}
        />
      ) : section === 'view' ? (
        <ViewPage
          viewId="view-a"
          source={source}
          laneHref={id => workHref({ lane: id })}
          intentHref={id => workHref({ intent: id })}
          viewHref={id => workHref({ viewId: id })}
          laneName={() => records.lanes[0].name}
          viewNumber={() => 1}
        />
      ) : section === 'planning' ? (
        <WorkPlanning
          data={{
            revision: 1,
            intents: records.intents,
            planningItems: [],
            planningComments: [],
            hostedEvents: [],
          }}
          busy={false}
          act={async () => {}}
          exportHistory={async () => ({ json: '{}', filename: 'planning.json', sha256: head })}
        />
      ) : (
        <div className="fx-page">
          {crumbs}
          <h1>{section === 'file' ? 'Code' : section === 'review' ? 'Review and accept' : 'Actions'}</h1>
          <div className="fx-page-actions">
            {lifecycle}
            <ObjectActions head={head} />
            <Menu label="More">
              <Button disabled>Unavailable action</Button>
              <Button onClick={() => select('copied')}>Copy record</Button>
              <Button data-destructive onClick={() => select('removed')}>
                Remove record
              </Button>
            </Menu>
          </div>
          <p role="status">{selected}</p>
          <nav aria-label="Detail tabs">
            {(['summary', 'changes', 'discussion'] as const).map(value => (
              <Button key={value} onClick={() => choose(value)}>
                {value}
              </Button>
            ))}
          </nav>
          <p>Selected tab: {tab}</p>
          <Button onClick={() => navigate('?surface=menus&lane=lane-a')}>Open Lane detail</Button>
          <a href={codeSourceLink(head, 'lane-a')}>Browse Lane source</a>
          {section === 'file' && (
            <SourcePicker
              current={currentSource(head, 'lane-a', sources, records.lanes)}
              options={sources}
              choose={() => {}}
            />
          )}
          {section === 'file' && (
            <pre style={{ overflowX: 'auto' }}>
              export const roundInvoice = (amount: number) =&gt; Math.round(amount * 100) / 100;
            </pre>
          )}
        </div>
      )}
      {dialog && (
        <LifecycleDialog
          action={dialog}
          collection="intents"
          reason={reason}
          setReason={setReason}
          saveFirst={saveFirst}
          setSaveFirst={setSaveFirst}
          cascade={cascade}
          setCascade={setCascade}
          busy={false}
          submit={() => {
            select(reason);
            setDialog(null);
          }}
          close={() => setDialog(null)}
        />
      )}
    </Shell>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
