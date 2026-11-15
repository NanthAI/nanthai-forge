// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { useConvex } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import type { AutonomyPolicy } from '../../../src/autonomy-policy';
import { Button } from '../ui/primitives';
import { ErrorToast } from '../ui/Toast';
import { hostedError } from '../snapshot';
type Selection = NonNullable<AutonomyPolicy['acceptance']['withoutCheck']>;
type Entry = { operationId: string; at: string; previous?: Selection; policy?: Selection };
export function UncheckedLandingHistory({
  projectId,
  disabled,
  revision,
  undo,
}: {
  projectId: Id<'hostedProjects'>;
  disabled: boolean;
  revision: AutonomyPolicy;
  undo: (value: Selection) => Promise<void>;
}) {
  const client = useConvex();
  const [rows, setRows] = useState<Entry[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState<AutonomyPolicy | null>(null);
  const load = async (reset = false) => {
    setBusy(true);
    setError('');
    try {
      const page = await client.query(api.projectUncheckedLandingSettings.history, {
        projectId,
        paginationOpts: { cursor: reset ? null : (cursor ?? null), numItems: 20 },
      });
      setRows(old => (reset ? page.page : [...old, ...page.page]));
      setCursor(page.isDone ? undefined : page.continueCursor);
      setLoaded(revision);
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setBusy(false);
    }
  };
  const labels = {
    owner: 'Owner only',
    selected: 'Owner and chosen people or teams',
    writers: 'Owner and all write members',
  };
  return (
    <details
      onToggle={event => {
        if (event.currentTarget.open && loaded !== revision) void load(true);
      }}
    >
      <summary>Landing policy history</summary>
      {loaded && rows.length === 0 && <p>No unchecked landing policy changes in this page.</p>}
      <ul className="reader-list">
        {rows.map(row => (
          <li key={row.operationId}>
            <span>
              {labels[row.policy?.mode ?? 'owner']} ·{' '}
              <time dateTime={row.at}>{new Date(row.at).toLocaleString()}</time>
            </span>
            <Button
              disabled={disabled || busy}
              onClick={() => void undo(row.previous ?? { mode: 'owner', people: [], teams: [] })}
            >
              Undo
            </Button>
          </li>
        ))}
      </ul>
      {loaded && cursor !== undefined && (
        <Button disabled={busy} onClick={() => void load()}>
          More policy changes
        </Button>
      )}
      {error && <ErrorToast>{error}</ErrorToast>}
    </details>
  );
}
