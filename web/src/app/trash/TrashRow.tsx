// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// One project in the Trash (SPEC-01-trash, "Screens" 3): name and address, time left, size, and the keys its phase
// allows. Layout is the screen's own grid (`row.tr`); everything else is the design system's.
import { Key, Row, State, type StateWord } from '../../ds';
import { address, movedWords, sizeText, trashForm, type TrashProject } from './trash-model';

const TONE_WORD: Record<'active' | 'failed' | 'passed' | 'stale', StateWord> = {
  passed: 'Done',
  failed: 'Check failed',
  stale: 'Set aside',
  active: 'In progress',
};

export type RowAction = 'restore' | 'forever' | 'retry';

export function TrashRow({
  project,
  now,
  busy,
  act,
}: {
  project: TrashProject;
  now: number;
  /** An action on this row is running: its keys wait. */
  busy: boolean;
  act: (action: RowAction, project: TrashProject) => void;
}) {
  const form = trashForm(project, now);
  const size = sizeText(project);
  const unknown = size === 'not reported';
  const moved = movedWords(project);
  const out = form.kind === 'deleted';
  return (
    <Row
      className={`tr${out ? ' out' : ''}`}
      cols="minmax(0, 1fr) 232px 104px auto"
      weight={out ? 'ref' : undefined}
    >
      <span className="nm">
        <span className="ttl" dir="auto" translate="no">
          {project.name || 'Deleted project'}
        </span>
        <span className="meta">
          <span className="mono any" translate="no">
            {address(project)}
          </span>
          {moved ? ` · ${moved}` : ''}
          {form.note ? ` · ${form.note}` : ''}
          {project.hiding ? <span role="status"> · Hiding in progress…</span> : null}
        </span>
      </span>
      <span className="left">
        {form.left ? (
          <>
            <b>{form.left.head}</b>
            <span>{form.left.sub}</span>
          </>
        ) : form.state ? (
          <>
            <State word={TONE_WORD[form.state.tone]}>{form.state.word}</State>
            {form.state.reason ? <span>{form.state.reason}</span> : null}
          </>
        ) : null}
        <span className={`only-narrow${unknown ? ' nr' : ''}`}> · {size}</span>
      </span>
      <span className={`r num sz${unknown ? ' nr' : ''}`}>{size}</span>
      <span className="btns">
        {form.keys.includes('restore') || form.keys.includes('restore-wait') ? (
          <Key
            size="sm"
            disabled={busy || form.keys.includes('restore-wait')}
            onClick={() => act('restore', project)}
          >
            Restore
          </Key>
        ) : null}
        {form.keys.includes('forever') ? (
          <Key size="sm" kind="danger" disabled={busy} onClick={() => act('forever', project)}>
            Delete forever
          </Key>
        ) : null}
        {form.keys.includes('retry') ? (
          <Key size="sm" disabled={busy} onClick={() => act('retry', project)}>
            Retry
          </Key>
        ) : null}
        {form.keys.includes('ask') ? (
          <a className="lk" href="https://forge.nanthai.tech/docs/operations#project-retention-and-restore">
            Ask the operator
          </a>
        ) : null}
      </span>
    </Row>
  );
}
