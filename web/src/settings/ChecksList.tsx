// SPDX-License-Identifier: Apache-2.0
import { useState, type ReactNode } from 'react';
import { age } from '../ui/status';
import { useNow } from '../shell/StatusBar';
import { Panel, StatusPill } from '../ui/primitives';
import { checksModel, type CheckHeader, type CheckRun } from './checks-model';
export function ChecksList({
  checks,
  runs,
  required,
  command,
  edit,
  loading = false,
}: {
  checks: CheckHeader[];
  runs: CheckRun[];
  required: ReadonlySet<string>;
  command: (check: CheckHeader) => ReactNode;
  edit?: (check: CheckHeader) => ReactNode;
  loading?: boolean;
}) {
  const now = useNow(),
    [query, setQuery] = useState(''),
    [olderOpen, setOlderOpen] = useState(false);
  const model = checksModel(checks, runs, required, now, query);
  const names = checks.filter(check => required.has(check.id)).map(check => check.name);
  const rows = (items: CheckHeader[]) =>
    items.map(check => {
      const run = model.latest.get(check.id),
        status = run?.status;
      return (
        <div className="fx-check-table-row" key={check.id}>
          <div className="fx-check-definition">
            <b title={check.name}>{check.name}</b>
            {command(check)}
          </div>
          <span className="fx-check-frequency">
            {required.has(check.id)
              ? 'before accept'
              : `${model.counts.get(check.id) ?? 0} ${(model.counts.get(check.id) ?? 0) === 1 ? 'run' : 'runs'}`}
          </span>
          <div className="fx-check-last">
            {status ? (
              <>
                <StatusPill
                  tone={
                    status === 'passed'
                      ? 'passed'
                      : status === 'failed'
                        ? 'failed'
                        : ['queued', 'preparing', 'running'].includes(status)
                          ? 'running'
                          : 'stale'
                  }
                >
                  {{
                    passed: 'Ready',
                    failed: 'Check failed',
                    cancelled: 'Cancelled',
                    interrupted: 'Interrupted',
                    queued: 'Waiting',
                    preparing: 'Checking',
                    running: 'Checking',
                  }[status] ?? status}
                </StatusPill>
                <span title={new Date(run!.startedAt).toLocaleString('en-GB')}>
                  {age(run!.startedAt, now)}
                </span>
              </>
            ) : (
              <span className="fx-muted">No runs</span>
            )}
          </div>
          {edit?.(check)}
        </div>
      );
    });
  return (
    <>
      <p className="fx-settings-summary" aria-busy={loading}>
        {loading ? (
          'Reading checks…'
        ) : (
          <>
            <b>
              {checks.length} {checks.length === 1 ? 'check' : 'checks'}
            </b>{' '}
            ·{' '}
            {names.length
              ? `${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''} before accept`
              : 'No checks recorded before accept'}{' '}
            · {model.today} {model.today === 1 ? 'run' : 'runs'} today, {model.failed} failed.
          </>
        )}
      </p>
      {checks.length > 5 && (
        <input
          type="search"
          aria-label="Find a check"
          placeholder="Find a check"
          value={query}
          onChange={event => {
            setQuery(event.target.value);
          }}
        />
      )}
      <Panel title="Checks" count={checks.length}>
        <div className={`fx-check-table-head${edit ? ' fx-check-editable' : ''}`}>
          <span>Check</span>
          <span>Runs</span>
          <span>Last run</span>
          {edit && <span aria-hidden="true" />}
        </div>
        {loading ? (
          <p className="fx-settings-note" role="status">
            Reading checks…
          </p>
        ) : !checks.length ? (
          <p className="fx-settings-note">No checks defined.</p>
        ) : !model.active.length && !model.older.length ? (
          <p className="fx-settings-note">No matching checks.</p>
        ) : (
          <>
            {rows(model.active)}
            {!!model.older.length && (
              <details
                className="fx-older-checks"
                open={olderOpen}
                onToggle={event => setOlderOpen(event.currentTarget.open)}
              >
                <summary>Older checks ({model.older.length})</summary>
                {olderOpen && rows(model.older)}
              </details>
            )}
          </>
        )}
      </Panel>
    </>
  );
}
