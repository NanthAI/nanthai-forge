// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Settings / People and access > Teams (Item b6588425, line 4d; docs/access.md#teams). The owner sees the teams linked
// to the project with their role, and links, changes or unlinks one. One-off reads, no subscription: the links
// (projectTeamAccess.list, at most 50) once when the owner opens the screen and once after each change, the owner's
// own teams (accountTeams.list, 20 a page) only when the link form opens. Nothing polls, so an idle tab costs nothing.
// The server decides: `set` carries the revision the owner read, so a stale screen or a retry is refused, never applied.
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useConvex } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { Menu, State } from '../../ds';
import { A } from '../frames';
import { hrefFor } from '../paths';
import { Cell } from './access-cells';

type Role = 'read' | 'write';
type Links = { revision: number; teams: { teamId: Id<'teams'>; name: string; role: Role }[] };
type Read = { state: 'loading' } | { state: 'failed'; last?: Links } | { state: 'ok'; links: Links };
export type TeamLinks = { read: Read; load: () => Promise<Links | undefined> };
type Undo = { teamId: Id<'teams'>; name: string; role: Role; revision: number };
const said = (error: unknown) =>
  (error as { data?: { message?: string } })?.data?.message ??
  'Forge did not answer, so the change may or may not have applied. The list shows what is saved now.';
const PAGE = 20;

/** The links read, shared by the Teams section and the page's head sentence: one read when the owner opens the page. */
export function useTeamLinks(projectId: Id<'hostedProjects'>, enabled: boolean): TeamLinks {
  const client = useConvex();
  const [read, setRead] = useState<Read>({ state: 'loading' });
  const last = useRef<Links | undefined>(undefined);
  const load = useCallback(
    () =>
      client.query(api.projectTeamAccess.list, { projectId }).then(
        links => ((last.current = links), setRead({ state: 'ok', links }), links),
        () => (setRead({ state: 'failed', last: last.current }), undefined),
      ),
    [client, projectId],
  );
  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);
  return { read, load };
}

export const linksOf = ({ read }: TeamLinks) =>
  read.state === 'ok' ? read.links : read.state === 'failed' ? read.last : undefined;

export default function ProjectTeams({
  projectId,
  teams,
}: {
  projectId: Id<'hostedProjects'>;
  teams: TeamLinks;
}) {
  const client = useConvex();
  const { read, load } = teams;
  const [linking, setLinking] = useState(false);
  const [pending, setPending] = useState(false);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [error, setError] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const opened = useRef(false);
  const busy = useRef(false);
  const links = linksOf(teams);
  useEffect(() => {
    if (!linking && opened.current) trigger.current?.focus();
  }, [linking]);
  /** One change at a time: it carries the revision this screen read, and the links are read again afterwards, also
   * after a refusal (a stale revision above all), so the next try is current. */
  const change = async (teamId: Id<'teams'>, role: Role | null, revision = links?.revision) => {
    if (busy.current || revision === undefined) return;
    busy.current = true;
    setPending(true);
    setError('');
    try {
      await client.mutation(api.projectTeamAccess.set, { projectId, teamId, role, revision });
      return await load();
    } catch (e) {
      setError(said(e));
      void load();
      throw e;
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  const quiet = (work: Promise<unknown>) => work.catch(() => undefined);
  const unlink = async (row: { teamId: Id<'teams'>; name: string; role: Role }) => {
    setUndo(null);
    const fresh = await change(row.teamId, null);
    if (fresh) setUndo({ ...row, revision: fresh.revision });
  };
  return (
    <section className="region people-teams" aria-label="Teams" aria-busy={read.state === 'loading'}>
      <div className="ph plain">
        <h2>Teams</h2>
        {links && !linking ? (
          <span className="tools">
            <button
              ref={trigger}
              type="button"
              className="btn sm"
              onClick={() => ((opened.current = true), setLinking(true))}
            >
              Link a team
            </button>
          </span>
        ) : null}
      </div>
      {error ? (
        <div className="notice" data-st="failed" role="alert">
          <State word="Check failed">Not changed</State>
          <p>{error}</p>
        </div>
      ) : null}
      {undo ? (
        <div className="notice" data-st="passed" role="status">
          <State word="Done">Unlinked</State>
          <p>
            {undo.name} no longer gets {undo.role} access through this link. People with their own access keep
            it.
          </p>
          <button
            type="button"
            className="btn sm"
            disabled={pending}
            onClick={() => (setUndo(null), quiet(change(undo.teamId, undo.role, undo.revision)))}
          >
            Undo
          </button>
        </div>
      ) : null}
      {read.state === 'failed' ? (
        <div className="notice" data-st="failed" role="status">
          <State word="Check failed">Not read</State>
          <p>The linked teams could not be read just now.{links ? ' What was last shown stays here.' : ''}</p>
          <button type="button" className="btn sm" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : null}
      {read.state === 'loading' ? (
        <div className="skrow" aria-label="Loading teams">
          <span className="sk" />
        </div>
      ) : null}
      {linking && links ? (
        <LinkForm
          linked={links.teams.map(row => row.teamId)}
          onLink={(teamId, role) => (setUndo(null), change(teamId, role))}
          onClose={() => setLinking(false)}
        />
      ) : null}
      {links?.teams.length ? (
        <>
          <div className="th acc" style={{ '--cols': 2 } as React.CSSProperties}>
            <span>Team</span>
            <span>Read</span>
            <span>Write</span>
            <span />
          </div>
          {links.teams.map(row => {
            const next: Role = row.role === 'write' ? 'read' : 'write';
            const flip = () => (setUndo(null), quiet(change(row.teamId, next)));
            return (
              <div key={row.teamId} className="row acc" style={{ '--cols': 2 } as React.CSSProperties}>
                <span className="nm">
                  <span className="who">
                    <span className="av none" aria-hidden="true">
                      {row.name.slice(0, 1).toLowerCase()}
                    </span>
                    <span>{row.name}</span>
                  </span>
                  <span className="sub">team · {row.role}</span>
                </span>
                <Cell k="Read" on />
                <span className="c">
                  <span className="k">Write</span>
                  <input
                    className="sw"
                    type="checkbox"
                    role="switch"
                    checked={row.role === 'write'}
                    disabled={pending}
                    aria-label={`${row.name}, write`}
                    onChange={() => void flip()}
                  />
                </span>
                <Menu
                  label={`More for ${row.name}`}
                  className="icb"
                  items={[
                    {
                      id: 'role',
                      label: row.role === 'write' ? 'Change to read' : 'Change to write',
                      onAction: () => void flip(),
                    },
                    'separator',
                    {
                      id: 'unlink',
                      label: 'Unlink from the project',
                      danger: true,
                      onAction: () => void quiet(unlink(row)),
                    },
                  ]}
                >
                  <span aria-hidden="true">⋯</span>
                </Menu>
              </div>
            );
          })}
        </>
      ) : links && !linking ? (
        <p className="quietline">No team is linked.</p>
      ) : null}
    </section>
  );
}

/** The owner's own teams, read only when the form opens; a team already linked is not offered. */
function LinkForm({
  linked,
  onLink,
  onClose,
}: {
  linked: Id<'teams'>[];
  onLink: (teamId: Id<'teams'>, role: Role) => Promise<unknown>;
  onClose: () => void;
}) {
  const client = useConvex();
  const [owned, setOwned] = useState<{ id: Id<'teams'>; name: string }[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const [role, setRole] = useState<Role>('read');
  const [team, setTeam] = useState('');
  const paging = useRef(false);
  const [busy, setBusy] = useState(false);
  const page = useCallback(
    (from: string | null) => {
      if (paging.current) return Promise.resolve();
      paging.current = true;
      return client
        .query(api.accountTeams.list, { paginationOpts: { cursor: from, numItems: PAGE } })
        .then(
          result => {
            const mine = result.page
              .filter(team => team.role === 'owner')
              .map(({ id, name }) => ({ id, name }));
            setOwned(before => [...(from ? (before ?? []) : []), ...mine]);
            setCursor(result.isDone ? null : result.continueCursor);
            setMore(!result.isDone);
            setFailed(false);
          },
          () => setFailed(true),
        )
        .finally(() => (paging.current = false));
    },
    [client],
  );
  useEffect(() => void page(null), [page]);
  const choices = (owned ?? []).filter(row => !linked.includes(row.id));
  // A team that left the choices (linked from another tab) counts as nothing chosen, in the same render: the browser
  // would otherwise show, and Link submit, the next team.
  const chosen = choices.some(row => row.id === team) ? team : '';
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!chosen || busy) return;
    setBusy(true);
    onLink(chosen as Id<'teams'>, role).then(onClose, () => setBusy(false));
  };
  return (
    <form className="notice" data-st="active" onSubmit={submit} aria-busy={busy || (!owned && !failed)}>
      <label className="f people-who">
        Your team
        <select
          className="inp"
          required
          autoFocus
          disabled={!choices.length}
          value={chosen}
          onChange={event => setTeam(event.target.value)}
        >
          <option value="" disabled>
            {!owned && !failed ? 'Reading your teams…' : choices.length ? 'Choose a team' : 'No team to link'}
          </option>
          {choices.map(row => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </select>
        <span className="help">
          {failed ? (
            <>
              Your teams could not be read.{' '}
              <button type="button" className="btn sm ghost" onClick={() => void page(cursor)}>
                Retry
              </button>
            </>
          ) : owned && !choices.length && !more ? (
            <>
              {owned.length ? 'All your teams are linked.' : 'You own no team yet.'}{' '}
              <A href={hrefFor({ frame: 'account', place: 'people' })}>People and teams</A>
            </>
          ) : more ? (
            <button type="button" className="btn sm ghost" onClick={() => void page(cursor)}>
              Show {PAGE} more teams
            </button>
          ) : (
            'Only teams you own can be linked.'
          )}
        </span>
      </label>
      <span className="f people-role">
        Gives
        <span className="seg" role="group" aria-label="Gives">
          {(['read', 'write'] as const).map(value => (
            <button key={value} type="button" aria-pressed={role === value} onClick={() => setRole(value)}>
              {value === 'read' ? 'Read' : 'Write'}
            </button>
          ))}
        </span>
      </span>
      <span className="btns">
        <button className="btn primary" disabled={busy || !choices.length}>
          Link
        </button>
        <button type="button" className="btn ghost" onClick={onClose}>
          Not now
        </button>
      </span>
    </form>
  );
}
