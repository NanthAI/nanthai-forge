import { ErrorToast } from './ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { DetailPanel } from './DetailPanel';
import { useEffect, useRef, useState } from 'react';
import { useConvex } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { hostedError } from './snapshot';
import './legacy-account-data.css';

type Page<T> = { page: T[]; isDone: boolean; continueCursor: string };
type Kind = 'project' | 'import' | 'secret' | 'agent' | 'team' | 'view' | 'interest';
type Leave = 'readers' | 'zones' | 'teams' | 'projects' | 'secrets';
type Item = { kind: Kind; id: string; pin: string; metadata: Record<string, unknown> };
type Receipt = { operationId: string; request: string; stage: string; at: number };
type Pending = { operationId: string; selection: { kind: Kind; id: string; pin: string }[]; leave: Leave[] };
const kinds: Kind[] = ['project', 'import', 'secret', 'agent', 'team', 'view', 'interest'];
const leaves: Leave[] = ['readers', 'zones', 'teams', 'projects', 'secrets'];
const label = (item: Item) => String(item.metadata.name ?? item.metadata.repository ?? item.id);
const key = (item: Item) => item.kind + ':' + item.id;
export default function AccountData({ userId }: { userId: string }) {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const journalKey = `forge-account-operation:${userId}`;
  const originalsKey = `forge-account-original-requests:${userId}`;
  const restore = (): Pending | null => {
    try {
      return JSON.parse(localStorage.getItem(journalKey) ?? 'null') as Pending | null;
    } catch {
      return null;
    }
  };
  const restoreOriginals = (): Pending[] => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(originalsKey) ?? '[]');
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  };
  const client = useConvex(),
    [items, setItems] = useState<Item[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [leave, setLeave] = useState<Leave[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]),
    [loaded, setLoaded] = useState(false),
    [observedAt, setObservedAt] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [pending, setPending] = useState<Pending | null>(restore),
    [status, setStatus] = useState('');
  const [originals, setOriginals] = useState<Pending[]>(restoreOriginals);
  function remember(request: Pending) {
    const saved = restoreOriginals(),
      next = saved.some(r => r.operationId === request.operationId) ? saved : [...saved, request];
    localStorage.setItem(originalsKey, JSON.stringify(next));
    setOriginals(next);
  }
  function selectOriginal(request: Pending) {
    setPending(request);
    localStorage.setItem(journalKey, JSON.stringify(request));
    setSelected([]);
    setLeave([]);
    setError('');
    setStatus('Original request selected. Reconcile it to inspect its existing outcome.');
  }
  async function chooseAnother() {
    if (!pending) return;
    remember(pending);
    setPending(null);
    localStorage.removeItem(journalKey);
    setSelected([]);
    setLeave([]);
    await refresh();
  }
  async function refresh() {
    setBusy(true);
    setError('');
    try {
      const observed = new Date().toISOString();
      const rows: Item[] = [];
      for (const kind of kinds) {
        let cursor: string | null = null;
        for (;;) {
          const p: Page<Item> = await client.action(api.accountActions.inventory, {
            kind,
            paginationOpts: { cursor, numItems: 50 },
          });
          rows.push(...p.page);
          if (p.isDone) break;
          cursor = p.continueCursor;
        }
      }
      const history: Receipt[] = [];
      let cursor: string | null = null;
      for (;;) {
        const p: Page<Receipt> = await client.query(api.accountPlan.receipts, {
          paginationOpts: { cursor, numItems: 50 },
        });
        history.push(...p.page);
        if (p.isDone) break;
        cursor = p.continueCursor;
      }
      setObservedAt(observed);
      setItems(rows);
      setReceipts(history);
      setLoaded(true);
      setSelected([]);
      setStatus('Current ownership inventory loaded.');
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setBusy(false);
    }
  }
  async function download() {
    setBusy(true);
    setError('');
    try {
      const archive = {
        kind: 'forge-account-metadata',
        schemaVersion: 1,
        observedAt,
        coverage: kinds,
        items,
        sourceAndCredentialBytes: 'separate current-authorized exports',
        receipts,
        grantsAuthority: 'historical-only',
      };
      const text = JSON.stringify(archive, null, 2) + '\n',
        bytes = new TextEncoder().encode(text),
        sha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), x =>
          x.toString(16).padStart(2, '0'),
        ).join('');
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' })),
        a = document.createElement('a');
      a.href = url;
      a.download = 'forge-account-metadata.json';
      a.click();
      URL.revokeObjectURL(url);
      setStatus(`Metadata downloaded · SHA-256 ${sha}`);
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setBusy(false);
    }
  }
  async function advance(operationId: string) {
    let latest: Receipt | undefined;
    let delay = 1000,
      previousStage: string | undefined;
    do {
      let cursor: string | null = null;
      for (;;) {
        const p: Receipt & { cursor: string | null; isDone: boolean } = await client.action(
          api.accountActions.advance,
          { operationId, cursor },
        );
        latest = p;
        if (p.isDone || !mounted.current) break;
        cursor = p.cursor;
      }
      if (!mounted.current) return latest!;
      setStatus(`Operation ${operationId} · ${latest?.stage}.`);
      const result = await client.query(api.accountPlan.read, { operationId });
      setReceipts(old => [result, ...old.filter(x => x.operationId !== operationId)]);
      if (latest?.stage === 'completed') break;
      delay = previousStage === latest?.stage ? Math.min(30_000, delay * 2) : 1000;
      previousStage = latest?.stage;
      await new Promise(resolve => setTimeout(resolve, delay));
    } while (mounted.current);
    return latest!;
  }

  async function run() {
    setBusy(true);
    setError('');
    const request = pending ?? {
      operationId: crypto.randomUUID(),
      selection: items.filter(x => selected.includes(key(x))).map(({ kind, id, pin }) => ({ kind, id, pin })),
      leave,
    };
    remember(request);
    setPending(request);
    localStorage.setItem(journalKey, JSON.stringify(request));
    try {
      await client.action(api.accountActions.begin, request);
      const r = await advance(request.operationId);
      if (r.stage === 'completed') {
        setPending(null);
        localStorage.removeItem(journalKey);
      }
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setBusy(false);
    }
  }
  async function resume(operationId: string) {
    setBusy(true);
    setError('');
    try {
      await advance(operationId);
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  return (
    <section className="account-data">
      <h2>Your Forge data</h2>
      <p>
        Export your ownership metadata or remove selected Forge resources. Source archives and encrypted
        SecretObjects use their own export controls.
      </p>
      <button disabled={busy} onClick={() => void refresh()}>
        Refresh inventory
      </button>
      {loaded && (
        <button disabled={busy} onClick={() => void download()}>
          Download metadata
        </button>
      )}
      {error && <ErrorToast>{error}</ErrorToast>}
      {status && <p role="status">{status}</p>}
      {error && pending && (
        <button disabled={busy} onClick={() => void chooseAnother()}>
          Choose another selection
        </button>
      )}
      {pending && (
        <DetailPanel title={<>Original operation selection</>}>
          <pre>{JSON.stringify(pending, null, 2)}</pre>
        </DetailPanel>
      )}
      {!!originals.length && (
        <DetailPanel title={<>Retained original requests</>}>
          <p>
            Choosing another selection does not cancel or roll back an original operation. Its request and
            server receipt remain available.
          </p>
          <ul>
            {originals.map(request => (
              <li key={request.operationId}>
                <DetailPanel title={<>{request.operationId}</>}>
                  <pre>{JSON.stringify(request, null, 2)}</pre>
                  <button
                    disabled={busy || pending?.operationId === request.operationId}
                    onClick={() => selectOriginal(request)}
                  >
                    Restore original request
                  </button>
                </DetailPanel>
              </li>
            ))}
          </ul>
        </DetailPanel>
      )}
      {loaded && (
        <>
          <DetailPanel title={<>Select resources to remove</>}>
            <p>
              Projects, private imports, SecretObjects and teams are deleted. Agent access is revoked;
              personal saved views and interests are removed. Other people’s resources remain.
            </p>
            {!items.length ? (
              <p>No owned resources in this inventory.</p>
            ) : (
              <ul>
                {items.map(item => (
                  <li key={key(item)}>
                    <label>
                      <input
                        type="checkbox"
                        disabled={busy || !!pending}
                        checked={selected.includes(key(item))}
                        onChange={e =>
                          setSelected(old =>
                            e.target.checked ? [...old, key(item)] : old.filter(x => x !== key(item)),
                          )
                        }
                      />
                      {label(item)} · {item.kind}
                    </label>
                    <DetailPanel title={<>Metadata and pin</>}>
                      <pre>{JSON.stringify(item, null, 2)}</pre>
                    </DetailPanel>
                  </li>
                ))}
              </ul>
            )}
            <fieldset>
              <legend>Leave incoming access (optional)</legend>
              {leaves.map(kind => (
                <label key={kind}>
                  <input
                    type="checkbox"
                    disabled={busy || !!pending}
                    checked={leave.includes(kind)}
                    onChange={e =>
                      setLeave(old => (e.target.checked ? [...old, kind] : old.filter(x => x !== kind)))
                    }
                  />
                  {kind === 'readers'
                    ? 'Shared imports'
                    : kind === 'zones'
                      ? 'Source Zones'
                      : kind === 'secrets'
                        ? 'SecretObject grants'
                        : kind === 'projects'
                          ? 'Project contribution'
                          : 'Team memberships'}
                </label>
              ))}
            </fieldset>
            <DetailPanel title={<>Scope and reconciliation details</>}>
              <p>
                This applies to the recorded selection. Changed resources are preserved. Your Clerk identity,
                provider credentials, downloaded copies, other people’s work and minimal operation receipts
                remain. You can create new Forge resources afterward.
              </p>
            </DetailPanel>
            <button
              disabled={busy || (!pending && !selected.length && !leave.length)}
              onClick={() => void run()}
            >
              {pending ? 'Reconcile original operation' : 'Remove selected Forge data'}
            </button>
          </DetailPanel>
        </>
      )}
      {!!receipts.length && (
        <DetailPanel title={<>Recorded operations</>}>
          <ul>
            {receipts.map(r => (
              <li key={r.operationId}>
                <code>{r.operationId}</code> · {r.stage}
                {['ready', 'running'].includes(r.stage) && (
                  <button disabled={busy} onClick={() => void resume(r.operationId)}>
                    Continue original operation
                  </button>
                )}
              </li>
            ))}
          </ul>
        </DetailPanel>
      )}
    </section>
  );
}
