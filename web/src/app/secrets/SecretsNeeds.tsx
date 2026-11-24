// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Needs you: the one first stop. Removed computers to take out, names to rotate and proposals, each with the one
// command a person copies and runs on a terminal. This page changes nothing.
import { Band, Region, State, Who } from '../../ds';
import { SecretCommand } from './SecretCommand';
import {
  KIND_WORD,
  OPERATION,
  UNSHARE_MARKED,
  applyCommand,
  count,
  exact,
  needsOf,
  rejectCommand,
  relative,
  setCommand,
  setLabel,
  type Overview,
  type OverviewSet,
} from './secrets-model';

type Needs = ReturnType<typeof needsOf>;
const owner = (handle: string | null) =>
  handle ? <Who handle={handle} /> : <span className="t3">(not reported)</span>;

function TakeOut({ rows, now }: { rows: Needs['takeOut']; now: number }) {
  return (
    <>
      <Band
        title="Take out removed computers"
        count={rows.length}
        hint="they open nothing new; the next change by a person re-keys"
      />
      {rows.map(row => (
        <div className="secret-need" key={`${row.set}:${row.codes.join()}`}>
          <div className="secret-what">
            {row.handle ? <Who handle={row.handle} /> : 'A computer'}
            {row.left
              ? ' left the project'
              : row.handle
                ? ' had a computer signed out'
                : ' was removed'} ·{' '}
            {row.codes.map((code, i) => (
              <span key={code}>
                {i ? ', ' : ''}
                <span className="dcode">{code}</span>
              </span>
            ))}{' '}
            still listed in {setLabel(row.set)}
            <span className="meta">
              {row.at ? (
                <>
                  <time title={exact(row.at)}>{relative(row.at, now)}</time> ·{' '}
                </>
              ) : null}
              {count(row.codes.length, 'computer')}
            </span>
          </div>
          <div className="btns">
            <SecretCommand command={UNSHARE_MARKED} label={`Copy: ${UNSHARE_MARKED}`} />
          </div>
        </div>
      ))}
    </>
  );
}

function Rotate({
  rows,
  total,
  sets,
  onMore,
  busy,
}: {
  rows: Needs['rotate'];
  total: number;
  sets: readonly OverviewSet[];
  onMore: (kind: 1 | 2 | 3) => void;
  busy: boolean;
}) {
  const more = sets.find(set => set.rotate?.next);
  return (
    <>
      <Band
        title="To rotate"
        count={total}
        hint={
          total > rows.length
            ? `first ${rows.length.toLocaleString()} shown`
            : 'a removed computer could open these values: replace each at its provider, then set it'
        }
      />
      {rows.map(row => (
        <div className="secret-need" key={`${row.set}:${row.name}`}>
          <div className="secret-what">
            <span className="mono" translate="no">
              {row.name}
            </span>{' '}
            <span className="t2">
              {KIND_WORD[row.kind]} · {setLabel(row.set)}
            </span>
            <span className="meta">
              <State word="Needs you" state="waiting">
                To rotate
              </State>{' '}
              · fp{' '}
              {row.devices.map((device, i) => (
                <span key={device.code}>
                  {i ? ', ' : ''}
                  <span className="dcode">{device.code}</span> (
                  {device.handle ? `@${device.handle}` : 'not reported'})
                </span>
              ))}
              {row.more ? ` and ${count(row.more, 'more computer')}` : ''} could open v
              {row.version.toLocaleString()}
            </span>
          </div>
          <div className="btns">
            <SecretCommand command={setCommand(row.name, row.kind === 2 ? 2 : 1)} label="Copy command" />
          </div>
        </div>
      ))}
      {more ? (
        <p className="pf">
          {rows.length.toLocaleString()} of {total.toLocaleString()} to rotate shown ·{' '}
          <button type="button" className="btn sm ghost" disabled={busy} onClick={() => onMore(more.kind)}>
            Show the next 100
          </button>
        </p>
      ) : null}
    </>
  );
}

function Proposals({ rows, now }: { rows: Needs['proposals']; now: number }) {
  const kinds = new Set(rows.map(row => row.set));
  return (
    <>
      <Band
        title="Proposals"
        count={rows.length}
        hint={
          rows.length >= 32
            ? 'the most Development holds: new proposals are refused until some are applied or rejected'
            : 'an agent asked to change a value; a person applies or rejects it on a terminal'
        }
      />
      {rows.map(row => (
        <div className="secret-need" key={row.id}>
          <div className="secret-what">
            <span className="secret-op">{row.op ? OPERATION[row.op] : 'propose'}</span>{' '}
            <span className="mono" translate="no">
              {row.name}
            </span>{' '}
            <span className="t2">
              ({row.kind ? KIND_WORD[row.kind] : 'unknown kind'})
              {kinds.size > 1 ? ` · ${setLabel(row.set)}` : ''}
            </span>
            <span className="meta">
              from fp <span className="dcode">{row.from}</span> · {owner(row.handle)} · proposed{' '}
              <time title={exact(row.at)}>{relative(row.at, now)}</time> · id{' '}
              <span className="dcode" title={row.id}>
                {row.id.slice(0, 8)}
              </span>
            </span>
          </div>
          <div className="btns">
            <SecretCommand command={applyCommand(row.id)} label="Copy apply" />
            <SecretCommand command={rejectCommand(row.id)} label="Copy reject" />
          </div>
        </div>
      ))}
    </>
  );
}

export function SecretsNeeds({
  data,
  now,
  onMore,
  busy,
}: {
  data: Overview;
  now: number;
  onMore: (kind: 1 | 2 | 3, part: 'rotate') => void;
  busy: boolean;
}) {
  const needs = needsOf(data);
  if (!needs.total) return null;
  return (
    <Region
      title="Needs you"
      weight="act"
      waiting={needs.total}
      count={needs.total}
      hint="each is done in a terminal; this page changes nothing"
    >
      {needs.takeOut.length ? <TakeOut rows={needs.takeOut} now={now} /> : null}
      {needs.rotateTotal ? (
        <Rotate
          rows={needs.rotate}
          total={needs.rotateTotal}
          sets={data.sets}
          busy={busy}
          onMore={kind => onMore(kind, 'rotate')}
        />
      ) : null}
      {needs.proposals.length ? <Proposals rows={needs.proposals} now={now} /> : null}
    </Region>
  );
}
