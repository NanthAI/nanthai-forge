import { ErrorToast } from '../ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { Button } from '../ui/primitives';
import type { CockpitLane } from '../cockpit/model';
export function Combine({
  lanes,
  run,
}: {
  lanes: readonly CockpitLane[];
  run: (inputs: { laneId: string; head: string }[]) => Promise<string | null>;
}) {
  const [open, setOpen] = useState(false),
    [chosen, setChosen] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const candidates = lanes.filter(lane => lane.open && lane.checkpoints > 0);
  if (!candidates.length) return null;
  if (!open)
    return (
      <Button
        icon="view"
        onClick={() => {
          setChosen(candidates.map(lane => lane.id));
          setOpen(true);
        }}
      >
        Combine into a Candidate
      </Button>
    );
  return (
    <form
      className="fx-combine"
      onSubmit={event => {
        event.preventDefault();
        setBusy(true);
        void run(
          candidates
            .filter(lane => chosen.includes(lane.id))
            .map(lane => ({ laneId: lane.id, head: lane.head })),
        )
          .then(problem => {
            setError(problem ?? '');
            if (!problem) setOpen(false);
          })
          .finally(() => setBusy(false));
      }}
    >
      <fieldset>
        <legend>Lanes in this Candidate</legend>
        {candidates.map(lane => (
          <label key={lane.id}>
            <input
              type="checkbox"
              checked={chosen.includes(lane.id)}
              onChange={event =>
                setChosen(event.target.checked ? [...chosen, lane.id] : chosen.filter(id => id !== lane.id))
              }
            />
            {lane.name} @ save {lane.checkpoints}
          </label>
        ))}
      </fieldset>
      {error && <ErrorToast>{error}</ErrorToast>}
      <Button type="submit" disabled={busy || !chosen.length}>
        {busy ? 'Combining…' : 'Combine'}
      </Button>
      <Button variant="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </form>
  );
}
