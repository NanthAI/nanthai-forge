// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { Button } from '../ui/primitives';

export type OwnerReview = {
  accept: () => void;
  decline: (why: string) => void;
  busy?: boolean;
};
/** Accept or decline one landing held for the project owner (Issue fe5bea80). The caller passes it
 * only to a signed-in owner; the server refuses everyone else, agents and device sign-ins included. */
export function OwnerReviewActions({ review }: { review: OwnerReview }) {
  const [declining, setDeclining] = useState(false),
    [why, setWhy] = useState('');
  if (declining)
    return (
      <div className="fx-confirm">
        <label className="fx-field-label">
          Why <span className="fx-faint">(optional, sent to the agent)</span>
          <input className="fx-input" value={why} onChange={event => setWhy(event.target.value)} />
        </label>
        <div className="fx-land-actions">
          <Button variant="primary" disabled={review.busy} onClick={() => review.decline(why)}>
            Decline landing
          </Button>
          <Button variant="ghost" disabled={review.busy} onClick={() => setDeclining(false)}>
            Not now
          </Button>
        </div>
      </div>
    );
  return (
    <div className="fx-land-actions">
      <Button variant="primary" disabled={review.busy} onClick={review.accept}>
        Accept into main
      </Button>
      <Button variant="ghost" disabled={review.busy} onClick={() => setDeclining(true)}>
        Decline…
      </Button>
    </div>
  );
}
