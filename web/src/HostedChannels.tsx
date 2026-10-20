import { ErrorToast } from './ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { Icon } from './Icons';
import { WorkTimeline } from './WorkTimeline';
import { DetailPanel } from './DetailPanel';
import { useState } from 'react';
import { useConvex, useQuery } from 'convex/react';
import type { FunctionArgs } from 'convex/server';
import type { Id } from '../../convex/_generated/dataModel';
import { api } from '../../convex/_generated/api';
import type { WorkData, HostedChannelMove } from '../../src/work-types';
import { HostedRevertAcceptance } from './lane/RevertAcceptance';
import { OwnerDecision } from './lane/OwnerDecision';
import { hostedError } from './snapshot';

export default function HostedChannels({
  projectId,
  archiveSha256,
  data,
  channels,
  sourceLabels = {},
}: {
  projectId: Id<'hostedProjects'>;
  archiveSha256: string;
  data: Pick<WorkData, 'revision' | 'channelMoves' | 'hostedChannelMoves'> &
    Partial<Pick<WorkData, 'views' | 'runs'>>;
  channels: HostedChannelMove[];
  sourceLabels?: Record<string, string>;
}) {
  const client = useConvex(),
    [name, setName] = useState('main'),
    [selected, setSelected] = useState('');
  const [pending, setPending] = useState<FunctionArgs<typeof api.projectWorkActions.acceptChannel> | null>(
      null,
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const candidates = [
    ...(data.views ?? [])
      .filter(view => view.status === 'clean' && view.head)
      .map(view => ({
        id: view.id,
        viewId: view.id,
        head: view.head!,
        at: view.at,
        move: data.channelMoves.find(
          move => move.viewId === view.id && move.head === view.head && move.status === 'accepted',
        ),
      })),
    ...data.channelMoves
      .filter(move => move.status === 'accepted' && !(data.views ?? []).some(view => view.id === move.viewId))
      .map(move => ({ id: move.id, viewId: move.viewId, head: move.head, at: move.at, move })),
  ];
  const selectedView = candidates.find(item => item.id === selected);
  const selectedMove = selectedView?.move;
  const ownerStatus = useQuery(api.ownerAcceptance.status, {
    projectId,
    viewId: selectedView?.viewId ?? '',
    channel: name.trim() || 'main',
  });
  async function accept() {
    const view = selectedView;
    if (!pending && (!view || !name.trim())) return;
    const original = pending ?? {
      projectId,
      operationId: crypto.randomUUID(),
      revision: data.revision,
      command: JSON.stringify({
        action: 'accept-hosted-channel',
        channel: name.trim(),
        ...(view!.move ? { acceptanceId: view!.move.id } : {}),
        viewId: view!.viewId,
        head: view!.head,
        archiveSha256,
        previousId: channels.find(item => item.channel === name.trim())?.id ?? null,
      }),
    };
    setPending(original);
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await client.action(api.projectWorkActions.acceptChannel, original);
      setMessage(
        'state' in result
          ? 'Requested. Waiting for the canonical owner receipt.'
          : 'Hosted source selection updated. The previous selection remains in history.',
      );
      setPending(null);
      if (!('state' in result)) setSelected('');
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="accepted-versions" aria-label="Canonical hosted Channels">
      <h3>
        <Icon name="channel" />
        Accepted versions
      </h3>
      <p>
        {ownerStatus?.native
          ? 'Native Channels move on the canonical owner after its local receipt. These retained hosted selections describe hosted source.'
          : 'A Channel names the source accepted for this project. Choosing a version here does not publish a GitHub PR or deploy the app.'}
      </p>
      <ul className="accepted-channel-list">
        {channels.map(move => (
          <li key={move.id}>
            <Icon name="channel" />
            <strong>{move.channel}</strong>
            <span>Selected {new Date(move.at).toLocaleString()}</span>
          </li>
        ))}
      </ul>
      <div className="accept-version-form">
        <label>
          Hosted Channel name
          <input value={name} disabled={busy || !!pending} onChange={e => setName(e.target.value)} />
        </label>
        <label>
          Clean Candidate or retained acceptance
          <select value={selected} disabled={busy || !!pending} onChange={e => setSelected(e.target.value)}>
            <option value="">Choose a Candidate</option>
            {candidates
              .sort((a, b) => b.at.localeCompare(a.at))
              .map(view => (
                <option key={view.id} value={view.id}>
                  {sourceLabels[view.viewId] ?? 'Candidate'} · {new Date(view.at).toLocaleString()}
                  {view.move
                    ? ' · accepted'
                    : (data.runs ?? []).some(
                          run =>
                            run.viewId === view.viewId && run.head === view.head && run.status === 'passed',
                        )
                      ? ' · check passed'
                      : ' · not checked'}
                </option>
              ))}
          </select>
        </label>
        {!ownerStatus?.native && (
          <button disabled={busy || (!pending && (!selected || !name.trim()))} onClick={() => void accept()}>
            {pending ? 'Reconcile hosted acceptance' : 'Accept source on hosted Channel'}
          </button>
        )}
      </div>
      {ownerStatus?.native && selectedView && (
        <OwnerDecision
          key={`${selectedView.viewId}:${name}`}
          projectId={projectId}
          viewId={selectedView.viewId}
          head={selectedView.head}
          status={ownerStatus}
          channel={name.trim() || 'main'}
          disabled={busy || !name.trim()}
        />
      )}
      {selectedMove && (
        <HostedRevertAcceptance
          key={selectedMove.id}
          projectId={projectId}
          move={selectedMove}
          base={selectedMove.head}
        />
      )}
      {pending && (
        <>
          <p>The acceptance is not yet confirmed. Retry checks the original request.</p>
          <button disabled={busy} onClick={() => setPending(null)}>
            Start another acceptance
          </button>
        </>
      )}
      {message && <p role="status">{message}</p>}
      {error && <ErrorToast>{error}</ErrorToast>}
      <WorkTimeline
        label="Hosted selection history"
        entries={(data.hostedChannelMoves ?? []).map(move => ({
          id: move.id,
          at: move.at,
          kind: 'Hosted selection',
          title: `${move.channel} · ${sourceLabels[move.viewId] ?? 'Accepted source'}`,
          detail: (
            <DetailPanel title="Source details">
              <p>
                Source <code>{move.head}</code>
              </p>
              <p>
                Actor <code>{move.actor}</code> · original selection <code>{move.id}</code>
              </p>
            </DetailPanel>
          ),
        }))}
      />
    </section>
  );
}
