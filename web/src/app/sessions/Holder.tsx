// SPDX-License-Identifier: Apache-2.0
import '../access.css';
import { useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import { useArchivePaginatedQuery } from '../../archive-pagination';
import { Avatar, Band, CodeBox, Key, Region, State, Who } from '../../ds';
import { Head } from '../Place';
import { hrefFor } from '../paths';
import type { PlaceProps } from '../screens';
import { when, type HolderRead } from './model';
import '../../ds/figures.css';
type Change = {
  takeover?: true;
  reason?: string;
  acceptHandoff?: string;
  handoff?: { sessionId: string; agent?: string; person?: string };
};
export default function Holder(props: PlaceProps) {
  const laneId = props.route.rest.split('/')[0]!;
  const result = useQuery(api.projectHolder.read, { projectId: props.projectId, laneId });
  const take = useMutation(api.projectHostedHolders.take);
  const history = useArchivePaginatedQuery(
    api.projectCoordination.feed,
    { projectId: props.projectId, laneId },
    { initialNumItems: 20 },
  );
  const data = result
    ? {
        ...(JSON.parse(result) as HolderRead),
        events: history.results.flatMap(event =>
          event.command.kind === 'change' && event.command.action?.startsWith('holder ')
            ? [{ id: event._id, person: event.actor, at: event.at, action: event.command.action }]
            : [],
        ),
        isDone: history.status === 'Exhausted',
        continueCursor: '',
      }
    : undefined;
  const [busy, setBusy] = useState(false),
    [problem, setProblem] = useState<string | null>(null);
  const [offer, setOffer] = useState<string | null>(null);
  const pending = useRef<{ change: string; request: string } | null>(null);
  const change = async (value: Change) => {
    if (!data?.browserSessionId) return;
    setBusy(true);
    setProblem(null);
    const key = JSON.stringify(value);
    try {
      if (!pending.current || pending.current.change !== key)
        pending.current = {
          change: key,
          request: JSON.stringify({
            operationId: crypto.randomUUID(),
            laneId,
            authorityEpoch: data.authorityEpoch,
            expected: { head: data.head, version: data.version },
            sessionId: data.browserSessionId,
            ...value,
          }),
        };
      const reply = JSON.parse(await take({ projectId: props.projectId, request: pending.current.request }));
      if (reply.result?.offerId) setOffer(reply.result.offerId);
      pending.current = null;
    } catch {
      setProblem('Forge could not finish the holder change. Try again; saved work is kept.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <HolderView
      route={props.route}
      data={data}
      busy={busy}
      problem={problem}
      offer={offer}
      change={change}
      more={() => history.loadMore(20)}
    />
  );
}
export function HolderView({
  route,
  data,
  busy,
  problem,
  offer,
  change,
  more,
}: Pick<PlaceProps, 'route'> & {
  data?: HolderRead;
  busy: boolean;
  problem: string | null;
  offer: string | null;
  change: (value: Change) => void;
  more: () => void;
}) {
  const [reason, setReason] = useState(''),
    [mode, setMode] = useState<'take' | 'handoff' | 'accept' | null>(null);
  const [target, setTarget] = useState(''),
    [person, setPerson] = useState(''),
    [offerId, setOfferId] = useState('');
  const holder = data?.holder,
    mine = holder?.sessionId === data?.browserSessionId;
  const title = data?.title ?? 'Lane holder';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    change(
      mode === 'handoff'
        ? { reason: reason || undefined, handoff: { sessionId: target, ...(person ? { person } : {}) } }
        : mode === 'accept'
          ? { acceptHandoff: offerId, ...(reason ? { reason } : {}) }
          : { takeover: true, ...(reason ? { reason } : {}) },
    );
  };
  return (
    <>
      <Head
        trail={[{ label: 'Lanes', href: hrefFor({ ...route, rest: '', section: '' }) }, { label: title }]}
        sentence={
          <>
            <b>
              {holder ? `${holder.agent ?? 'A person'} holds this Lane.` : 'No session holder is recorded.'}
            </b>{' '}
            Every change of holder keeps the saved work and its checks.
          </>
        }
      />
      {problem && (
        <p className="notice" role="alert">
          <State state="failed" word="Check failed">
            {problem}
          </State>
        </p>
      )}
      <div className="panes access-frame">
        <Region title="Held by" hint="one session writes a Lane at a time">
          {!data ? (
            <p className="pad" role="status">
              Loading holder…
            </p>
          ) : holder ? (
            <div className="holder">
              <Avatar handle={`${holder.actor}/${holder.agent ?? 'person'}`} />
              <div className="nm">
                <b translate="no">{holder.agent ?? 'Person'}</b> <span className="t2">acts for</span>{' '}
                <Who handle={holder.actor} />
                <span className="meta">
                  Since {when(holder.since)} · last seen {when(holder.lastSeen)}
                </span>
              </div>
              <div className="btns">
                <span className="mono">{mine ? 'You hold it' : 'Held'}</span>
              </div>
            </div>
          ) : (
            <p className="pad">The saved Lane predates explicit holders.</p>
          )}
          {data?.enabled && data.canTake && (
            <div className="pad btns">
              <Key size="sm" disabled={busy} onClick={() => setMode('take')}>
                {mine ? 'Resume here' : 'Take over here'}
              </Key>
              <Key size="sm" disabled={busy} onClick={() => setMode('handoff')}>
                Hand to…
              </Key>
              <Key size="sm" disabled={busy} onClick={() => setMode('accept')}>
                Accept a handoff
              </Key>
            </div>
          )}
          {mode && (
            <form className="pad stack" onSubmit={submit}>
              {mode === 'handoff' && (
                <>
                  <label className="f">
                    Session reference
                    <input
                      className="inp mono"
                      value={target}
                      onChange={e => setTarget(e.target.value)}
                      pattern="[0-9a-f]{64}"
                      required
                    />
                  </label>
                  <label className="f">
                    Person’s handle, if different
                    <input className="inp" value={person} onChange={e => setPerson(e.target.value)} />
                  </label>
                  <p className="sub">
                    The current holder stays until that session accepts. Get its reference with whoami.
                  </p>
                </>
              )}
              {mode === 'accept' && (
                <label className="f">
                  Handoff offer
                  <input
                    className="inp mono"
                    value={offerId}
                    onChange={e => setOfferId(e.target.value)}
                    required
                  />
                </label>
              )}
              <label className="f">
                Reason{mode === 'take' && data?.needsReason && !mine ? '' : ' (optional)'}
                <input
                  className="inp"
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  required={mode === 'take' && data?.needsReason && !mine}
                />
              </label>
              <div className="btns">
                <Key type="submit" disabled={busy}>
                  {mode === 'handoff'
                    ? 'Offer handoff'
                    : mode === 'accept'
                      ? 'Accept handoff'
                      : mine
                        ? 'Resume'
                        : 'Take over'}
                </Key>
                <Key kind="ghost" onClick={() => setMode(null)}>
                  Cancel
                </Key>
              </div>
            </form>
          )}
          {offer && (
            <div className="pad" role="status">
              <p>Handoff offered. The current holder stays until it is accepted.</p>
              <CodeBox label="Offer reference">{offer}</CodeBox>
            </div>
          )}
          <Band title="Holder history" hint="newest first: who, from whom, why" />
          {holder?.change && (
            <div className="row hold">
              <span className="num" title={when(holder.since)}>
                {new Date(holder.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
              <div>
                <p>
                  <Who handle={holder.change.by} /> · {holder.change.kind}
                </p>
                <p>
                  {holder.change.previous?.agent ?? 'No recorded session'} → {holder.agent ?? 'Person'}
                </p>
                {holder.change.reason && <p>“{holder.change.reason}”</p>}
                <span className="sub">Saved head {holder.change.savedHead.slice(0, 12)} kept</span>
              </div>
            </div>
          )}
          {data?.events.map(event => (
            <div className="row hold" key={event.id}>
              <span className="num" title={when(event.at)}>
                {new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
              <div>
                <Who handle={event.person} />
                <p>{event.action}</p>
              </div>
            </div>
          ))}
          {data && !data.isDone && (
            <div className="pad">
              <Key size="sm" onClick={more}>
                Earlier activity
              </Key>
            </div>
          )}
        </Region>
        <Region title="Which chat window?">
          <div className="pad">
            <p>Run this in the window you think it is.</p>
            <CodeBox label="In that chat window">nforge agent . whoami</CodeBox>
            <p className="sub">
              Match its session reference. A resumed thread keeps its name; another thread gets another name.
            </p>
            {data && <CodeBox label="Saved head">{data.head}</CodeBox>}
          </div>
        </Region>
      </div>
    </>
  );
}
