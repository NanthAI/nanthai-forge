// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// "Take it out of main" (Item 9e7a17df), the one person-facing undo of a landing, shared by the landing check, the
// proof page and Lane review. It starts the existing exact-change revert (BrowserLanding.revert): a new landing that
// removes exactly that change, checked and landed through the queue like any other; later landings stay and main is
// never rewound. It reads and writes only on a press.
import { useMemo, useState } from 'react';
import type { BrowserLanding } from '../lane/hosted-landing-client';
import { hostedError } from '../snapshot';

/** What a person reads after the press: what happened and what did not change. */
export const takenOutText =
  'Taking it out of main as a new landing. It is checked like any other; later landings stay.';

type Revert = Pick<BrowserLanding, 'revert'>;
export type TakenOut = { laneId: string; submissionId: string };

/**
 * One operation id per landed receipt, kept for the life of the page: a press retried after a lost reply, or a
 * second press, reconciles the same revert and never starts another. Pure apart from the revert call.
 */
export class TakeOut {
  private readonly operations = new Map<string, string>();
  constructor(
    private readonly landing: Revert,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}
  operationFor(receiptId: string) {
    if (!this.operations.has(receiptId)) this.operations.set(receiptId, this.newId());
    return this.operations.get(receiptId)!;
  }
  async press(receiptId: string, why: string): Promise<TakenOut> {
    const result = await this.landing.revert(this.operationFor(receiptId), receiptId, why);
    return { laneId: result.laneId, submissionId: result.submission.id };
  }
}

/** The press as React state: busy while the reverse landing is prepared, then the reverse Lane to follow. */
export function useTakeOut(landing: Revert) {
  const takeOut = useMemo(() => new TakeOut(landing), [landing]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<TakenOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  return {
    busy,
    done,
    error,
    async press(receiptId: string, why: string) {
      setBusy(true);
      setError(null);
      try {
        const result = await takeOut.press(receiptId, why);
        setDone(result);
        return result;
      } catch (failure) {
        setError(hostedError(failure));
        return null;
      } finally {
        setBusy(false);
      }
    },
  };
}
