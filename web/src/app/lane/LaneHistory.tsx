// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { useEffect, useRef, useState } from 'react';
import { useConvex } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { ConvexError } from 'convex/values';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { saveExpectedSchema } from '../../../../src/hosted-save';
import { undoReceiptSchema } from '../../../../src/hosted-undo';
import { Key, Row, State } from '../../ds';
import { hostedError, hostedErrorCode } from '../../snapshot';
import { Toasts, useToast } from '../trash/Toasts';
import { LaneSaveLoading } from './LaneSaveLoading';

type Page = FunctionReturnType<typeof api.projectHostedLaneHistory.saves>;
type Target = { saveId: string } | { version: number; returnOperationId: string };
type Attempt = { operationId: string; authorityEpoch: number; expected: Page['expected']; target: Target };
const waitWords = 'A landing is in progress. Wait for it to finish before returning to a save.';
const refusalWords = {
  closed: 'This Lane is closed. Saves are shown for reference.',
  native: 'This project manages Lane changes outside the browser. Saves are shown for reference.',
  'not-yours': 'Only the holder, author or project owner with Write access can return this Lane to a save.',
};

function returnImpact(index: number, current: number) {
  if (current < 0) return 'Current head is not a listed save. Returning replaces its changes with this save.';
  const later = index - current;
  if (later < 0) return 'Restores changes from this later save.';
  return later === 1
    ? 'Drops 1 later save from the current Lane. It stays in History.'
    : `Drops ${later} later saves from the current Lane. They stay in History.`;
}

/** Mounted only on the History tab. Rows are a finite read of one page, never a subscription. */
export default function LaneHistory({
  projectId,
  laneId,
}: {
  projectId: Id<'hostedProjects'>;
  laneId: string;
}) {
  const client = useConvex();
  const [page, setPage] = useState<Page>();
  const [loading, setLoading] = useState(true);
  const [readFailure, setReadFailure] = useState<{
    cursor: string | null;
    text: string;
    retry: boolean;
    keepItems: boolean;
  }>();
  const [failure, setFailure] = useState<{ text: string; attempt?: Attempt; reload?: true }>();
  const [pending, setPending] = useState<Attempt>();
  const inWrite = useRef(false);
  const readToken = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const { toast, show, clear } = useToast();

  async function load(cursor: string | null = null, keepItems = false) {
    const token = ++readToken.current;
    setLoading(true);
    setReadFailure(undefined);
    try {
      const value = await client.query(api.projectHostedLaneHistory.saves, { projectId, laneId, cursor });
      if (readToken.current === token)
        setPage(prior => {
          if (!prior) return value;
          if (keepItems) return { ...value, items: prior.items, nextCursor: prior.nextCursor };
          if (!cursor) return value;
          const items = new Map([...prior.items, ...value.items].map(save => [save.id, save]));
          return { ...value, items: [...items.values()] };
        });
    } catch (error) {
      if (readToken.current === token) {
        const code = hostedErrorCode(error);
        if (code) setPage(undefined);
        setReadFailure({
          cursor,
          keepItems,
          retry: !code,
          text: code ? hostedError(error) : 'Could not load saves. The Lane has not changed.',
        });
      }
    } finally {
      if (readToken.current === token) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    return () => void readToken.current++;
  }, [client, projectId, laneId]);

  async function apply(attempt: Attempt) {
    if (inWrite.current) return;
    inWrite.current = true;
    readToken.current++;
    setLoading(false);
    setPending(attempt);
    clear();
    const { operationId, expected, authorityEpoch, target } = attempt;
    const args = {
      projectId,
      request: JSON.stringify({ kind: 'undo', laneId, operationId, authorityEpoch, expected, ...target }),
    };
    const undoing = 'returnOperationId' in target;
    try {
      let text: string;
      try {
        text = await client.mutation(api.projectHostedUndo.returnToSave, args);
      } catch (error) {
        if (!(error instanceof ConvexError) || error.data?.undoHistory !== true) throw error;
        text = await client.action(api.projectHostedUndoArchive.returnToSave, args);
      }
      const receipt = undoReceiptSchema.parse(JSON.parse(text));
      if (
        receipt.operationId !== operationId ||
        receipt.lane.laneId !== laneId ||
        receipt.from.laneId !== laneId ||
        receipt.lane.projectId !== projectId ||
        receipt.lane.head !== receipt.restored.head ||
        receipt.from.version !== expected.version ||
        receipt.from.head !== expected.head ||
        receipt.from.sourceVersion !== expected.sourceVersion ||
        receipt.from.lifecycleVersion !== expected.lifecycleVersion ||
        (!undoing && receipt.restored.saveId !== target.saveId) ||
        (undoing && receipt.restored.version !== target.version)
      )
        throw new Error('The return receipt does not match this Lane.');
      const pins = saveExpectedSchema.parse(receipt.lane);
      setPage(value => value && { ...value, expected: pins, waiting: false });
      setFailure(undefined);
      // The button for the now-current save is gone. Keep keyboard focus inside History.
      heading.current?.focus({ preventScroll: true });
      if (undoing) show('Return undone. All saves are still in History.');
      else if (receipt.from.version === pins.version) show('This save is already current.');
      else {
        const inverse: Attempt = {
          operationId: crypto.randomUUID(),
          authorityEpoch,
          expected: pins,
          target: { version: receipt.from.version, returnOperationId: receipt.operationId },
        };
        show('Returned to this save. All saves are still in History.', () => apply(inverse));
      }
    } catch (error) {
      const code = hostedErrorCode(error);
      if (undoing) heading.current?.focus({ preventScroll: true });
      setFailure(
        code === 'LANE_FINISH_ACTIVE'
          ? { text: waitWords, attempt }
          : code === 'WORK_STALE'
            ? { text: 'The Lane changed. Refresh its saves to choose a version.', reload: true }
            : code
              ? { text: hostedError(error) }
              : {
                  text: 'Could not confirm the return. Retry the same request to see what happened.',
                  attempt,
                },
      );
    } finally {
      setPending(undefined);
      inWrite.current = false;
    }
  }

  const hasAlternatives = page && (page.items.length > 1 || page.nextCursor !== null);
  const actions = hasAlternatives && !page.refusal;
  const returnBlocked = Boolean(
    pending ||
    loading ||
    page?.waiting ||
    readFailure?.cursor === null ||
    failure?.attempt ||
    failure?.reload,
  );
  const currentIndex = page?.items.findIndex(save => save.head === page.expected.head) ?? -1;
  return (
    <section className="region lane-saves" aria-labelledby="lane-saves-title">
      <div className="ph plain">
        <h2 id="lane-saves-title" ref={heading} tabIndex={-1}>
          Saves
        </h2>
      </div>
      <Toasts toast={toast} onGone={clear} />
      {hasAlternatives && page.refusal ? <p className="quietline">{refusalWords[page.refusal]}</p> : null}
      {page?.waiting ? (
        <div className="notice" data-st="waiting">
          <State word="Waiting its turn">Landing in progress</State>
          <p>{waitWords}</p>
          <Key
            size="sm"
            aria-disabled={loading || Boolean(pending)}
            onClick={() => {
              if (!loading && !inWrite.current) void load(null, true);
            }}
          >
            Check again
          </Key>
        </div>
      ) : null}
      {failure ? (
        <div className="notice" data-st="failed" role="alert">
          <p>{failure.text}</p>
          {failure.attempt ? (
            <Key size="sm" aria-disabled={Boolean(pending)} onClick={() => void apply(failure.attempt!)}>
              Retry return
            </Key>
          ) : null}
          {failure.reload ? (
            <Key
              size="sm"
              disabled={loading}
              onClick={() => {
                setFailure(undefined);
                void load();
              }}
            >
              Refresh saves
            </Key>
          ) : null}
        </div>
      ) : null}
      <div aria-busy={loading}>
        {page?.items.length ? (
          <ol className="lane-save-list" role="list">
            {page.items.map((save, index) => {
              const summary = save.summary ?? 'Save message not recorded';
              const current = index === currentIndex;
              const returning = pending && 'saveId' in pending.target && pending.target.saveId === save.id;
              return (
                <li key={save.id}>
                  <Row className="lane-save-row" cols="var(--lane-save-cols, minmax(0, 1fr) auto)">
                    <div>
                      <b className="any" dir="auto">
                        {summary}
                      </b>
                      <div className="meta">
                        <time dateTime={save.at}>
                          {new Date(save.at).toLocaleString(undefined, {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          })}
                        </time>
                        {' · '}
                        {save.fileCount === null
                          ? 'Files not recorded'
                          : `${save.fileCount.toLocaleString()} ${save.fileCount === 1 ? 'file' : 'files'} changed`}
                      </div>
                      {save.paths.length ? (
                        <div className="meta any">
                          <span dir="auto">{save.paths.join(', ')}</span>
                          {save.fileCount !== null && save.fileCount > save.paths.length ? ' and more' : null}
                        </div>
                      ) : null}
                      {actions && !current ? (
                        <div className="meta">{returnImpact(index, currentIndex)}</div>
                      ) : null}
                    </div>
                    {current ? (
                      <span className="meta">Current save</span>
                    ) : actions ? (
                      <Key
                        aria-disabled={returnBlocked}
                        aria-label={`${returning ? 'Returning' : 'Return to this save'}: ${summary}`}
                        onClick={() => {
                          if (returnBlocked) return;
                          void apply({
                            operationId: crypto.randomUUID(),
                            authorityEpoch: page.authorityEpoch,
                            expected: page.expected,
                            target: { saveId: save.id },
                          });
                        }}
                      >
                        {returning ? 'Returning…' : 'Return to this save'}
                      </Key>
                    ) : null}
                  </Row>
                </li>
              );
            })}
          </ol>
        ) : page ? (
          <p className="quietline">No saves yet.</p>
        ) : null}
      </div>
      {loading ? <LaneSaveLoading /> : null}
      {readFailure ? (
        <div className="notice" data-st="failed" role="alert">
          <p>{readFailure.text}</p>
          {readFailure.retry ? (
            <Key size="sm" onClick={() => void load(readFailure.cursor, readFailure.keepItems)}>
              Retry
            </Key>
          ) : null}
        </div>
      ) : !loading && page?.nextCursor ? (
        <div className="pad">
          <Key size="sm" disabled={Boolean(pending)} onClick={() => void load(page.nextCursor)}>
            Show earlier saves
          </Key>
        </div>
      ) : null}
    </section>
  );
}
