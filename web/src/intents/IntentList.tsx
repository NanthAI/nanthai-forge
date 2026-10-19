import { ErrorToast } from '../ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { PagedList, ScaleGroups, ScaleStatusCounts } from '../cockpit/ScaleList';
import { groupByInitiative, SCALE_AFTER, type InitiativeLinks } from '../cockpit/scale-model';
import { useUnsavedInput } from '../ui/NavigationGuard';
import { useId, useState } from 'react';
import { PageHead } from '../shell/Shell';
import { Glyph } from '../ui/Glyph';
import { Button, Dot, Panel, Segmented } from '../ui/primitives';
import { WorkRow } from '../ui/WorkRow';
import { age, toneLabel } from '../ui/status';
import { IntentBoard } from './IntentBoard';
import { useIntentLayout } from './useIntentLayout';
import { filterIntents, type IntentFilter, type IntentRow } from './model';

/** Every Intent as one row: what it is for, how its Lanes stand, when it last moved. */
export function IntentListView({
  rows,
  initiatives = new Map(),
  preferenceScope = 'local-browser-project',
  now,
  intentHref,
  create,
  countsKnown = true,
  creating: initiallyCreating = false,
}: {
  /** Open with the new-Intent form showing. */
  creating?: boolean;
  initiatives?: InitiativeLinks;
  preferenceScope?: string;
  rows: readonly IntentRow[];
  now: number;
  intentHref: (id: string) => string;
  /** `delegate` asks the page to open the new Intent with its hand-off sheet. */
  create?: (outcome: string, constraints: string, delegate?: boolean) => Promise<string | null>;
  countsKnown?: boolean;
}) {
  const { layout, filter, setLayout, setFilter, showDone } = useIntentLayout(preferenceScope);
  const [creating, setCreating] = useState(initiallyCreating);
  const shown = filterIntents(rows, filter);
  const count = (value: IntentFilter) => filterIntents(rows, value).length;
  const label = (name: string, value: IntentFilter) => (
    <>
      {name}
      <span className="fx-filter-count" style={{ visibility: countsKnown ? 'visible' : 'hidden' }}>
        <span className="fx-filter-separator" aria-hidden="true">
          ·
        </span>
        {count(value)}
      </span>
    </>
  );
  const render = (row: IntentRow) => (
    <WorkRow
      key={row.id}
      tone={row.tone}
      title={row.outcome}
      href={intentHref(row.id)}
      label={row.label}
      done={row.status === 'completed' || row.status === 'abandoned'}
      fact={
        (row.label !== 'Ready' || row.decisions > 0) && (
          <>
            {row.label !== 'Ready' &&
              (row.open.length === 0 ? (
                <span className="fx-faint">
                  {row.lanes.length
                    ? `${row.lanes.length} finished ${row.lanes.length === 1 ? 'Lane' : 'Lanes'}`
                    : 'No Lanes yet'}
                </span>
              ) : (
                row.open.slice(0, 4).map(lane => (
                  <span
                    key={lane.id}
                    className="fx-intent-lane"
                    title={`${lane.name}: ${toneLabel[lane.tone]}`}
                  >
                    <Dot tone={lane.tone === 'passed' ? 'passed' : lane.tone} />
                    <span>
                      {row.outcome.startsWith(lane.name) || lane.name.startsWith(row.outcome)
                        ? lane.fact
                        : lane.name}
                    </span>
                  </span>
                ))
              ))}
            {row.label !== 'Ready' && row.open.length > 4 && (
              <span className="fx-faint">+{row.open.length - 4} more</span>
            )}
            {row.decisions > 0 && (
              <span className="fx-intent-decisions" title="Recorded decisions">
                <Glyph name="message" size={11} /> {row.decisions}
              </span>
            )}
          </>
        )
      }
      age={
        row.lastAt && (
          <time title={new Date(row.lastAt).toLocaleString()} dateTime={row.lastAt}>
            {age(row.lastAt, now)}
          </time>
        )
      }
    />
  );
  const layoutControl = (
    <Segmented
      label="Intent layout"
      value={layout}
      onChange={setLayout}
      options={[
        { id: 'list', label: 'List' },
        { id: 'board', label: 'Board' },
      ]}
    />
  );
  return (
    <div className="fx-page">
      <PageHead
        title="Intents"
        actions={
          <>
            {layoutControl}
            {create && (
              <Button variant="primary" icon="plus" onClick={() => setCreating(true)} disabled={creating}>
                New Intent
              </Button>
            )}
          </>
        }
      />
      {creating && create && <NewIntent create={create} close={() => setCreating(false)} />}
      <Panel className="fx-intent-list-panel">
        {layout === 'list' && (
          <header className="fx-panel-h fx-intent-toolbar">
            <Segmented<IntentFilter>
              label="Show Intents"
              value={filter}
              onChange={setFilter}
              options={[
                { id: 'open', label: label('Open', 'open') },
                { id: 'ready', label: label('Ready', 'ready') },
                { id: 'done', label: label('Done', 'done') },
                { id: 'planned', label: label('Planned', 'planned') },
                { id: 'all', label: label('All', 'all') },
              ]}
            />
          </header>
        )}
        {layout === 'board' ? (
          <IntentBoard
            rows={rows}
            initiatives={initiatives}
            now={now}
            intentHref={intentHref}
            showDone={showDone}
          />
        ) : shown.length === 0 ? (
          <p className="fx-board-empty">{filter === 'open' ? 'No open Intents.' : 'Nothing here.'}</p>
        ) : shown.length > SCALE_AFTER ? (
          <ScaleGroups
            groups={groupByInitiative(shown, initiatives, row => row.id)}
            render={render}
            className="fx-wrs"
            noun="Intent"
            summary={rows => <ScaleStatusCounts rows={rows} />}
          />
        ) : (
          <PagedList rows={shown} render={render} className="fx-wrs" />
        )}
      </Panel>
    </div>
  );
}

function NewIntent({
  create,
  close,
}: {
  create: (outcome: string, constraints: string, delegate?: boolean) => Promise<string | null>;
  close: () => void;
}) {
  const [outcome, setOutcome] = useState(''),
    [constraints, setConstraints] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useUnsavedInput(Boolean(outcome.trim() || constraints.trim()), () => {
    setOutcome('');
    setConstraints('');
  });
  const id = useId();
  return (
    <form
      className="fx-panel fx-new-intent"
      onSubmit={event => {
        event.preventDefault();
        if (!outcome.trim() || busy) return;
        const delegate = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'delegate';
        setBusy(true);
        setError('');
        void create(outcome.trim(), constraints.trim(), delegate)
          .then(problem => (problem ? setError(problem) : close()))
          .finally(() => setBusy(false));
      }}
    >
      <label htmlFor={`${id}-o`} className="fx-field-label">
        What outcome do you want?
      </label>
      <input
        id={`${id}-o`}
        className="fx-input"
        autoFocus
        maxLength={500}
        value={outcome}
        placeholder="For example: Round tax to whole cents"
        onChange={event => setOutcome(event.target.value)}
      />
      <label htmlFor={`${id}-c`} className="fx-field-label">
        Constraints <span className="fx-faint">(optional)</span>
      </label>
      <textarea
        id={`${id}-c`}
        className="fx-input"
        rows={3}
        maxLength={4000}
        value={constraints}
        placeholder="Anything people and agents must respect while working on it."
        onChange={event => setConstraints(event.target.value)}
      />
      {error && <ErrorToast>{error}</ErrorToast>}
      <div className="fx-reply-actions">
        <Button size="sm" variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button size="sm" type="submit" value="delegate" icon="handoff" disabled={busy || !outcome.trim()}>
          Create &amp; hand to an agent
        </Button>
        <Button size="sm" variant="primary" type="submit" disabled={busy || !outcome.trim()}>
          {busy ? 'Creating…' : 'Create Intent'}
        </Button>
      </div>
    </form>
  );
}
