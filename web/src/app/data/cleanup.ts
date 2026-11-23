// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Account > Your data: driving a deletion (review 8e86eb09), apart from React so every outcome is tested in Node. A
// begin that Forge refused is `failed` with its words; one that went unanswered is `unknown`, and asking again sends
// the SAME stored request (same operation id), which the server reconciles. A pass that Forge refused is `failed`
// and is driven again on retry. A pass that ends with removals still running elsewhere is `waiting`, with the marks
// accountData.watch is compared against; there is no timer anywhere.
import { hostedError, hostedErrorCode } from '../../snapshot';
import { failure, type Kind, type Request, type Run } from './model';

export type Waiting = { kind: Kind; id: string; mark: string };
export type Step = {
  stage: string;
  cursor: string | null;
  isDone: boolean;
  waiting: Waiting[];
  kept?: number;
};
export type Calls = {
  begin: (request: Request) => Promise<{ stage: string }>;
  advance: (operationId: string, cursor: string | null) => Promise<Step>;
};
export type Outcome = { run: Run; waiting: Waiting[] };
/** The most resources one watch follows (accountData.WATCH_MAX); the page chains watches over the rest. */
export const WATCH_MAX = 50;

const said = (error: unknown) => ({ code: hostedErrorCode(error), message: hostedError(error) });

/** One pass over every page of the cleanup. */
export async function pass(calls: Calls, operationId: string, stage: string): Promise<Outcome> {
  try {
    let latest = stage,
      kept = 0;
    const waiting: Waiting[] = [];
    for (let cursor: string | null = null; ;) {
      const step = await calls.advance(operationId, cursor);
      latest = step.stage;
      kept = step.kept ?? 0;
      waiting.push(...step.waiting);
      if (step.isDone) break;
      cursor = step.cursor;
    }
    if (latest === 'completed')
      return { run: { operationId, stage: latest, status: 'done', kept }, waiting: [] };
    if (waiting.length) return { run: { operationId, stage: latest, status: 'waiting' }, waiting };
    return {
      run: {
        operationId,
        stage: latest,
        status: 'failed',
        words: 'This deletion stopped before it finished. Continue it to try the rest again.',
      },
      waiting: [],
    };
  } catch (error) {
    return { run: failure({ operationId, stage }, said(error)), waiting: [] };
  }
}

/** Begins (or reconciles: the same request with the same operation id) and then makes one pass. */
export async function begin(calls: Calls, request: Request): Promise<Outcome> {
  let stage: string;
  try {
    stage = (await calls.begin(request)).stage;
  } catch (error) {
    return {
      run: failure({ operationId: request.operationId, stage: 'preparing' }, said(error)),
      waiting: [],
    };
  }
  return pass(calls, request.operationId, stage);
}

/** Try again / Check again: a begin that stopped is sent again unchanged; a stopped pass is driven again. */
export function retry(calls: Calls, run: Run, pending: Request | null): Promise<Outcome> {
  return pending?.operationId === run.operationId && run.stage === 'preparing'
    ? begin(calls, pending)
    : pass(calls, run.operationId, run.stage);
}

/** Whether the watch saw a waiting removal (or the operation) move since the pass that left it waiting. `waiting` is
 * the part this watch follows, in the order it was sent. */
export function moved(
  watched: { stage: string; marks: readonly { mark: string }[] },
  run: Run,
  waiting: readonly Waiting[],
) {
  return watched.stage !== run.stage || watched.marks.some((m, i) => m.mark !== waiting[i]?.mark);
}
