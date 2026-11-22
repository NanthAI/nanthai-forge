// SPDX-License-Identifier: Apache-2.0
// Account > Your data (Item 17cdc774): what Forge holds for the account, the way to take it out, and deleting it.
// Reads (review 8e86eb09): one `accountData.overview` query on open (the first rows of each kind and the latest
// receipts; no provider call), a one-off read, not a subscription, so nothing runs while the tab is idle. Everything
// else runs only on a press: the export pages the inventory action (current provider checks); the review pages
// `accountData.owned` and `accountData.shared` into the exact before-list and the token that binds the cleanup to it;
// the cleanup is accountActions.begin + advance. Removals that run on elsewhere are followed by the reactive
// `accountData.watch` (only while the tab is shown), never by a timer. Person-only on the server.
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useConvex, useQuery } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import { Band, CodeBox, Key, Region, Row } from '../../ds';
import { A } from '../frames';
import { hrefFor } from '../paths';
import { Head } from '../Place';
import type { AccountProps } from '../screen-route';
import { hostedError } from '../../snapshot';
import {
  begin as beginRun,
  moved,
  pass,
  retry,
  WATCH_MAX,
  type Calls,
  type Outcome,
  type Waiting,
} from './cleanup';
import {
  KINDS,
  KIND_WORDS,
  SHARED,
  LEAVE_WORDS,
  confirmed,
  deleteWords,
  itemNote,
  kindCount,
  metadataArchive,
  request as requestFor,
  receiptWords,
  runWords,
  sentence,
  type Held,
  type Item,
  type Owned,
  type Receipt,
  type Request,
  type Review,
  type Run,
  type Shared,
} from './model';
import './data.css';

const PAGE = 50;
/** Rows of one kind shown in the before-list before "Show all" (long lists open in place). */
const SHOWN = 10;
type Page<T> = { page: T[]; isDone: boolean; continueCursor: string };
type Busy = 'export' | 'review' | 'delete' | null;

const journal = (handle: string | undefined) => `forge-account-operation:${handle ?? ''}`;
function remembered(handle: string | undefined): Request | null {
  try {
    const value = JSON.parse(localStorage.getItem(journal(handle)) ?? 'null') as Request | null;
    // A journal from before reviews carried their token cannot be reconciled; the receipts still offer Continue.
    return value && typeof value.incoming === 'string' ? value : null;
  } catch {
    return null;
  }
}
function remember(handle: string | undefined, request: Request | null) {
  try {
    if (request) localStorage.setItem(journal(handle), JSON.stringify(request));
    else localStorage.removeItem(journal(handle));
  } catch {
    // A private window keeps no journal; the receipts list still offers Continue.
  }
}
/** Whether the tab is shown; the watch is dropped while it is hidden and picked up again when it is shown. */
function useShown() {
  const [shown, setShown] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  );
  useEffect(() => {
    const change = () => setShown(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, []);
  return shown;
}

export default function YourData({ handle }: AccountProps) {
  const client = useConvex();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [held, setHeld] = useState<Held | null>(null);
  const [failed, setFailed] = useState(false);
  const [receipts, setReceipts] = useState<readonly Receipt[]>([]);
  const [busy, setBusy] = useState<Busy>(null);
  const [exported, setExported] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<Request | null>(() => remembered(handle));
  const [waiting, setWaiting] = useState<readonly Waiting[]>([]);
  const driving = useRef(false);
  const shown = useShown();

  const first = useCallback(() => {
    setFailed(false);
    client
      .query(api.accountData.overview, {})
      .then(view => {
        if (!alive.current) return;
        setHeld(
          Object.fromEntries(
            view.kinds.map(k => [k.kind, { rows: k.rows, more: k.more }]),
          ) as unknown as Held,
        );
        setReceipts(view.receipts);
      })
      .catch(() => alive.current && setFailed(true));
  }, [client]);
  useEffect(first, [first]);

  /** Every row of every kind with its current metadata, for the download only. */
  async function everything() {
    const rows: Item[] = [];
    for (const kind of KINDS)
      for (let cursor: string | null = null; ;) {
        const page = (await client.action(api.accountActions.inventory, {
          kind,
          paginationOpts: { cursor, numItems: PAGE },
        })) as Page<Item>;
        rows.push(...page.page);
        if (page.isDone) break;
        cursor = page.continueCursor;
      }
    return rows;
  }
  async function allReceipts() {
    const rows: Receipt[] = [];
    for (let cursor: string | null = null; ;) {
      const page: Page<Receipt> = await client.query(api.accountPlan.receipts, {
        paginationOpts: { cursor, numItems: PAGE },
      });
      rows.push(...page.page);
      if (page.isDone) return rows;
      cursor = page.continueCursor;
    }
  }
  /** The exact before-list: every owned row with its pin, everything visibly shared, and the token over all of it. */
  async function reviewAll(): Promise<Review> {
    const owned: Owned[] = [];
    for (const kind of KINDS)
      for (let cursor: string | null = null; ;) {
        const page: { rows: Owned[]; isDone: boolean; continueCursor: string } = await client
          .query(api.accountData.owned, { kind, cursor })
          .then(p => ({ ...p, rows: p.rows.map(row => ({ ...row, kind })) }));
        owned.push(...page.rows);
        if (page.isDone) break;
        cursor = page.continueCursor;
      }
    const shared: Shared[] = [];
    let token: string | null = null;
    for (const kind of SHARED)
      for (let cursor: string | null = null; ;) {
        const page: { rows: Shared[]; token: string; isDone: boolean; continueCursor: string } = await client
          .query(api.accountData.shared, {
            kind,
            cursor,
            token,
            ...(token === null ? { review: crypto.randomUUID() } : {}),
          })
          .then(p => ({ ...p, rows: p.rows.map(row => ({ ...row, kind })) }));
        token = page.token;
        shared.push(...page.rows);
        if (page.isDone) break;
        cursor = page.continueCursor;
      }
    return { owned, shared, incoming: token! };
  }
  async function press(kind: Exclude<Busy, null>, work: () => Promise<void>) {
    setBusy(kind);
    setError('');
    try {
      await work();
    } catch (failure) {
      if (alive.current) setError(hostedError(failure));
    } finally {
      if (alive.current) setBusy(null);
    }
  }
  const download = () =>
    press('export', async () => {
      const [items, history] = await Promise.all([everything(), allReceipts()]);
      const text = metadataArchive(items, history, new Date().toISOString());
      const bytes = new TextEncoder().encode(text);
      const sha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), x =>
        x.toString(16).padStart(2, '0'),
      ).join('');
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'forge-account-metadata.json';
      link.click();
      URL.revokeObjectURL(url);
      setExported(sha);
    });

  const calls: Calls = useMemo(
    () => ({
      begin: request => client.action(api.accountActions.begin, request) as Promise<{ stage: string }>,
      advance: (operationId, cursor) =>
        client.action(api.accountActions.advance, { operationId, cursor }) as ReturnType<Calls['advance']>,
    }),
    [client],
  );
  /** Runs one step of the deletion (begin, a pass or a retry) and shows where it stands. */
  const settle = useCallback(
    async (operationId: string, stage: string, work: () => Promise<Outcome>) => {
      if (driving.current) return;
      driving.current = true;
      setRun({ operationId, stage, status: 'working' });
      try {
        const { run: next, waiting: wait } = await work();
        if (!alive.current) return;
        setWaiting(wait);
        setRun(next);
        if (next.status === 'done') {
          remember(handle, null);
          setPending(null);
          setReview(null);
          first();
        }
      } finally {
        driving.current = false;
      }
    },
    [first, handle],
  );
  const start = (request: Request) =>
    press('delete', async () => {
      remember(handle, request);
      setPending(request);
      await settle(request.operationId, 'preparing', () => beginRun(calls, request));
    });
  const resume = (operationId: string) =>
    press('delete', () => settle(operationId, 'running', () => pass(calls, operationId, 'running')));

  const again = useCallback(
    (from: Run) => void settle(from.operationId, from.stage, () => pass(calls, from.operationId, from.stage)),
    [settle, calls],
  );

  return (
    <>
      {run?.status === 'waiting' && shown ? (
        <WatchFrom run={run} waiting={waiting} from={0} onMoved={again} />
      ) : null}
      <YourDataView
        held={held}
        failed={failed}
        retry={first}
        receipts={receipts}
        handle={handle}
        busy={busy}
        exported={exported}
        review={review}
        run={run}
        pending={pending}
        error={error}
        onDownload={() => void download()}
        onReview={() => void press('review', async () => setReview(await reviewAll()))}
        onCancel={() => setReview(null)}
        onDelete={() => review && void start(requestFor(crypto.randomUUID(), review))}
        onReconcile={() => pending && void start(pending)}
        onRetry={() =>
          run &&
          void press('delete', () => settle(run.operationId, run.stage, () => retry(calls, run, pending)))
        }
        onStartOver={() => {
          remember(handle, null);
          setPending(null);
          setRun(null);
          setReview(null);
          first();
        }}
        onContinue={operationId => void resume(operationId)}
      />
    </>
  );
}

/** Follows removals that run on elsewhere (and the operation's stage): the marks the last pass returned against the
 * same marks now. Any change starts the next pass. One watch reads a byte-capped prefix of what it is sent and marks
 * only that much (review fdd5e2f4: a resource can be a 1 MiB row), so the next watch starts where it stopped, until
 * every waiting resource is followed. Dropped while the tab is hidden; compared again when it is shown. */
function WatchFrom(props: {
  run: Run;
  waiting: readonly Waiting[];
  from: number;
  onMoved: (run: Run) => void;
}) {
  const { run, waiting, from, onMoved } = props;
  const part = useMemo(() => waiting.slice(from, from + WATCH_MAX), [waiting, from]);
  const watched = useQuery(api.accountData.watch, {
    operationId: run.operationId,
    resources: part.map(({ kind, id }) => ({ kind, id })),
  });
  useEffect(() => {
    if (watched && moved(watched, run, part)) onMoved(run);
  }, [watched, run, part, onMoved]);
  const next = watched ? from + watched.marks.length : waiting.length;
  return next < waiting.length && watched?.marks.length ? <WatchFrom {...props} from={next} /> : null;
}

const trail = [
  { label: 'Account', href: hrefFor({ frame: 'account', place: 'projects' }) },
  { label: 'Your data' },
];

export function YourDataView(props: {
  held: Held | null;
  failed: boolean;
  retry: () => void;
  receipts: readonly Receipt[];
  handle: string | undefined;
  busy: Busy;
  exported: string | null;
  review: Review | null;
  run: Run | null;
  pending: Request | null;
  error: string;
  onDownload: () => void;
  onReview: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onReconcile: () => void;
  onRetry: () => void;
  onStartOver: () => void;
  onContinue: (operationId: string) => void;
}) {
  const { held, failed, busy } = props;
  if (!held)
    return (
      <div className="your-data">
        <Head trail={trail} sentence={failed ? 'What Forge holds could not be read.' : 'Loading…'} />
        {failed ? (
          <div className="notice" role="status">
            <span>Your data could not be read just now.</span>
            <Key size="sm" onClick={props.retry}>
              Retry
            </Key>
          </div>
        ) : (
          <div className="sk-rows" aria-busy="true" aria-label="Loading your data">
            <div className="sk" />
            <div className="sk" />
            <div className="sk" />
          </div>
        )}
      </div>
    );
  return (
    <div className="your-data">
      <Head trail={trail} sentence={sentence(held)} />
      <Region title="What Forge holds" weight="watch">
        {KINDS.map(kind => {
          const rows = held[kind].rows;
          return (
            <Row key={kind} className="kind" cols="minmax(0, 1fr) auto">
              <span className="nm">
                <b>{KIND_WORDS[kind].title}</b>
                {rows.length ? (
                  <span className="meta" dir="auto" translate="no">
                    {rows
                      .slice(0, 3)
                      .map(row => row.label)
                      .join(', ')}
                    {rows.length > 3 || held[kind].more ? ', …' : ''}
                  </span>
                ) : null}
              </span>
              <span className="r cnt">{kindCount(kind, held[kind])}</span>
            </Row>
          );
        })}
      </Region>
      <Region title="Take it with you" weight="ref">
        <Row className="out" cols="minmax(0, 1fr) auto">
          <span className="nm">
            <b>Account metadata</b>
            <span className="meta">
              Everything listed above and your deletion receipts, as one JSON file. No source and no secret
              values.
            </span>
            {props.exported ? (
              <span className="meta mono" role="status">
                Downloaded forge-account-metadata.json · SHA-256 {props.exported}
              </span>
            ) : null}
          </span>
          <span className="r">
            <Key size="sm" disabled={!!busy} onClick={props.onDownload}>
              {busy === 'export' ? 'Reading…' : 'Download metadata'}
            </Key>
          </span>
        </Row>
        <div className="clone">
          <b>Project source, Work and history</b>
          <span className="meta">Clone each project you want to keep, with its address from its page:</span>
          <CodeBox label="Clone a project">nforge clone PROJECT-URL FOLDER</CodeBox>
        </div>
      </Region>
      <DeleteRegion {...props} />
      <p className="quietline">
        To remove one project, move it to the trash in{' '}
        <A href={hrefFor({ frame: 'account', place: 'projects' })}>Projects</A>. It stays there 90 days.
      </p>
      {props.receipts.length ? (
        <Region title="Earlier deletions" weight="ref" count={props.receipts.length}>
          {props.receipts.map(receipt => (
            <Row key={receipt.operationId} cols="minmax(0, 1fr) auto auto">
              <span className="meta">
                {new Date(receipt.at).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' })}
              </span>
              <span className="meta">{receiptWords(receipt.stage, receipt.kept)}</span>
              <span className="r">
                {['ready', 'running'].includes(receipt.stage) ? (
                  <Key size="sm" disabled={!!busy} onClick={() => props.onContinue(receipt.operationId)}>
                    Continue
                  </Key>
                ) : null}
              </span>
            </Row>
          ))}
        </Region>
      ) : null}
    </div>
  );
}

function RunLine({ run, busy, onRetry, onStartOver }: Parameters<typeof YourDataView>[0] & { run: Run }) {
  const stopped = run.status === 'failed' || run.status === 'unknown';
  return (
    <div className="pf">
      <p role={stopped ? 'alert' : 'status'}>
        {runWords(run)}
        {run.status === 'working' ? ' Keep this page open until it is done.' : ''}
      </p>
      {stopped ? (
        <div className="btns">
          {run.stale ? (
            <Key disabled={!!busy} onClick={onStartOver}>
              Review again
            </Key>
          ) : (
            <>
              <Key kind="danger" disabled={!!busy} onClick={onRetry}>
                {run.status === 'unknown' ? 'Check again' : 'Try again'}
              </Key>
              <Key disabled={!!busy} onClick={onStartOver}>
                Start over
              </Key>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function DeleteRegion(props: Parameters<typeof YourDataView>[0]) {
  const { review, busy, run, pending, handle } = props;
  const word = handle ?? 'delete';
  const [typed, setTyped] = useState('');
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const input = useRef<HTMLInputElement>(null);
  const owned = useMemo(() => review?.owned ?? [], [review]);
  const ok = confirmed(typed, word);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ok) return input.current?.focus();
    props.onDelete();
  };
  const group = (
    key: string,
    title: string,
    hint: string,
    rows: { id: string; label: string; note?: string | null }[],
  ) => {
    if (!rows.length) return null;
    const all = open.has(key);
    return (
      <div key={key} className="group">
        <Band title={title} count={rows.length} hint={hint} />
        {(all ? rows : rows.slice(0, SHOWN)).map(row => (
          <Row key={row.id} cols="minmax(0, 1fr) auto">
            <span className="nm" dir="auto" translate="no">
              {row.label}
            </span>
            <span className="meta">{row.note ?? null}</span>
          </Row>
        ))}
        {rows.length > SHOWN && !all ? (
          <Row cols="minmax(0, 1fr) auto">
            <span className="meta">{(rows.length - SHOWN).toLocaleString('en')} more</span>
            <Key size="sm" onClick={() => setOpen(new Set([...open, key]))}>
              Show all {rows.length.toLocaleString('en')}
            </Key>
          </Row>
        ) : null}
      </div>
    );
  };
  return (
    <Region title="Delete your Forge data" weight="ref">
      {run && run.status !== 'done' ? (
        <RunLine {...props} run={run} />
      ) : pending && !review ? (
        <div className="pf">
          <p>
            A deletion you started on this browser is not finished. Continuing it deletes only what it listed
            then.
          </p>
          <div className="btns">
            <Key kind="danger" disabled={!!busy} onClick={props.onReconcile}>
              Continue that deletion
            </Key>
          </div>
        </div>
      ) : !review ? (
        <div className="pf">
          {run?.status === 'done' ? <p role="status">{runWords(run)}</p> : null}
          <p>
            Deletes everything listed above and takes you out of what other people shared with you. Projects
            go for good, without the 90-day trash. Your sign-in, your provider accounts and copies you
            downloaded stay.
          </p>
          <div className="btns">
            <Key disabled={!!busy} onClick={props.onReview}>
              {busy === 'review' ? 'Reading…' : 'Review what would be deleted'}
            </Key>
          </div>
        </div>
      ) : (
        <>
          {KINDS.map(kind =>
            group(
              kind,
              KIND_WORDS[kind].title,
              KIND_WORDS[kind].goes,
              owned.filter(row => row.kind === kind).map(row => ({ ...row, note: itemNote(row) })),
            ),
          )}
          {SHARED.map(kind =>
            group(
              `leave:${kind}`,
              LEAVE_WORDS[kind],
              'you leave',
              review.shared.filter(row => row.kind === kind),
            ),
          )}
          <div className="pf">
            <p>
              {owned.length || review.shared.length ? 'You also leave ' : 'You leave '}
              {LEAVE_WORDS.secrets.toLowerCase()} up to when this list was read. Nothing else is touched.
            </p>
          </div>
          <form className="confirm" onSubmit={submit} noValidate>
            <label htmlFor="data-confirm">Type your handle, {word}, to confirm</label>
            <input
              id="data-confirm"
              ref={input}
              className="inp"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={typed}
              onChange={event => setTyped(event.target.value)}
              aria-describedby="data-confirm-help"
            />
            <p id="data-confirm-help" className="meta">
              Only you, signed in on the web, can do this. If anything on this list changes before the
              deletion starts, nothing is deleted and you review again; anything that changes while it runs is
              kept.
            </p>
            <div className="btns">
              <Key type="submit" kind="danger" disabled={!!busy || !ok}>
                {deleteWords(owned)}
              </Key>
              <Key disabled={!!busy} onClick={props.onCancel}>
                Cancel
              </Key>
            </div>
          </form>
        </>
      )}
      {props.error ? (
        <p className="err" role="alert">
          {props.error}
        </p>
      ) : null}
    </Region>
  );
}
