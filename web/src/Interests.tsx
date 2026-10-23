import { useInventory, useInterest } from './useInventory';
import { ErrorToast } from './ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { DetailPanel } from './DetailPanel';
import { useRef, useState } from 'react';
import { SignInButton, useUser } from '@clerk/react';
import { useConvex } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import { api } from '../../convex/_generated/api';
import { hostedError } from './snapshot';

function SignedInterestControls({ importId }: { importId: Id<'imports'> }) {
  const client = useConvex(),
    row = useInterest(importId);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState('');
  const [observation, setObservation] = useState<FunctionReturnType<
    typeof api.interestActions.observe
  > | null>(null);
  const pending = useRef<Parameters<typeof client.action<typeof api.interestActions.change>>[1] | null>(null);
  const change = async (update: NonNullable<typeof pending.current>['update']) => {
    if (!pending.current || JSON.stringify(pending.current.update) !== JSON.stringify(update))
      pending.current = {
        importId,
        operationId: crypto.randomUUID(),
        expectedRevision: row?.revision ?? 0,
        update,
      };
    setBusy(true);
    setError('');
    setSaved('');
    try {
      await client.action(api.interestActions.change, pending.current);
      pending.current = null;
      setSaved('Personal choice saved.');
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setBusy(false);
    }
  };
  const observe = async () => {
    setBusy(true);
    setError('');
    setObservation(null);
    try {
      setObservation(await client.action(api.interestActions.observe, { importId }));
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="save-view">
      <div className="import-actions">
        <button
          disabled={busy || row === undefined}
          aria-pressed={row?.starred ?? false}
          onClick={() => void change({ kind: 'star', value: !row?.starred })}
        >
          {row?.starred ? 'Unstar in Forge' : 'Star in Forge'}
        </button>
        <button
          disabled={busy || row === undefined}
          aria-pressed={row?.watching ?? false}
          onClick={() => void change({ kind: 'watch', value: !row?.watching })}
        >
          {row?.watching ? 'Stop watching in Forge' : 'Watch in Forge'}
        </button>
        {row?.watching && (
          <>
            <small>
              Watched ref <code>{row.ref}</code> · Seen <code>{row.seenHead?.slice(0, 12)}</code>
            </small>
            <button disabled={busy} onClick={() => void observe()}>
              Check watched revision
            </button>
          </>
        )}
      </div>
      {row?.watching && observation && (
        <p role="status">
          {observation.head === row.seenHead
            ? 'No new revision since your last seen head.'
            : 'Upstream revision changed.'}{' '}
          Current head <code>{observation.head.slice(0, 12)}</code> · Checked{' '}
          {new Date(observation.checkedAt).toLocaleString()}
          {observation.head !== row.seenHead && (
            <button disabled={busy} onClick={() => void change({ kind: 'seen', head: observation.head })}>
              Mark displayed revision seen
            </button>
          )}
        </p>
      )}
      {saved && <p role="status">{saved}</p>}
      {error && (
        <>
          <ErrorToast>{error}</ErrorToast>
          {pending.current && (
            <button disabled={busy} onClick={() => void change(pending.current!.update)}>
              Reconcile original personal choice
            </button>
          )}
          <button
            disabled={busy}
            onClick={() => {
              pending.current = null;
              setError('');
            }}
          >
            Use latest personal choice revision
          </button>
        </>
      )}
    </div>
  );
}
export function InterestControls({ importId }: { importId: Id<'imports'> }) {
  const { isSignedIn, user } = useUser();
  return isSignedIn ? (
    <SignedInterestControls key={user?.id} importId={importId} />
  ) : (
    <div className="save-view">
      <SignInButton mode="modal">
        <button>Sign in to star or watch</button>
      </SignInButton>
    </div>
  );
}
function InterestItem({ item }: { item: Doc<'projectInterests'> }) {
  return (
    <li>
      <div>
        <strong>{item.repository || 'Unavailable import'}</strong>
        <small>
          {item.ref} · {item.starred ? 'Starred' : ''}
          {item.starred && item.watching ? ' · ' : ''}
          {item.watching ? 'Watching' : ''}
        </small>
      </div>
      <a href={`?codescape=${item.importId}`}>Explore followed import</a>
      <DetailPanel
        className="item-provenance personal-interest-tools"
        title={<>Star, watch & revision controls</>}
      >
        <InterestControls importId={item.importId} />
      </DetailPanel>
    </li>
  );
}
export default function Interests() {
  const { results, status, loadMore } = useInventory(api.interests.list, 'interests', {}, 20);
  return (
    <section className="private-imports" aria-label="Your stars and watches">
      <h2>Stars and watches</h2>
      <DetailPanel className="collection-guide" title={<>About stars & watches</>}>
        <p className="hosted-note">
          Private Forge choices for existing imports. Watching records a seen Git revision; check for changes
          here. No email, background indexing or GitHub star is sent. Current access is required to explore or
          check. You can stop following even after source access is lost.
        </p>
      </DetailPanel>
      {status === 'LoadingFirstPage' ? (
        <p>Loading your choices…</p>
      ) : results.length === 0 ? (
        <p>No starred or watched imports yet.</p>
      ) : (
        <ul className="import-list">
          {results.map(item => (
            <InterestItem key={item._id} item={item} />
          ))}
        </ul>
      )}
      {status === 'CanLoadMore' && <button onClick={() => loadMore(20)}>Load more personal choices</button>}
    </section>
  );
}
