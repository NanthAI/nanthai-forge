// SPDX-License-Identifier: Apache-2.0
// Account > People and teams (Item a841a76d): invitations waiting for the person, then the teams they own or are in,
// each with its owner and members by handle. One bounded read per visit (convex/accountTeams.ts, 20 teams a page;
// "Show more" reads the next page by its cursor), read again when the tab is shown and after the person changes a
// team. A one-off read, not a subscription: nothing runs while the tab is idle. Owners manage their teams on the
// existing server paths (teams.create, teamActions.addByEmail, teams.removeMember); organizations stay proposed.
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useConvex } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { Key, Region, Row, Who } from '../../ds';
import { hrefFor } from '../paths';
import { Head } from '../Place';
import type { AccountProps } from '../screen-route';
import Invitations from './Invitations';
import { teamMeta, teamsSentence, type TeamRow, type TeamsRead } from './teams-model';
import './people.css';

const PAGE = 20;
type Read = { state: 'loading' } | { state: 'failed'; last?: TeamsRead } | { state: 'ok'; data: TeamsRead };
export type TeamActions = {
  create: (name: string) => Promise<void>;
  add: (team: Id<'teams'>, email: string) => Promise<void>;
  remove: (team: Id<'teams'>, key: string) => Promise<void>;
};

const said = (error: unknown) =>
  (error as { data?: { message?: string } })?.data?.message ?? 'Forge did not answer. Try again.';

function useAccountTeams() {
  const client = useConvex();
  const [read, setRead] = useState<Read>({ state: 'loading' });
  const last = useRef<TeamsRead | undefined>(undefined);
  const cursor = useRef<string | null>(null);
  const page = useCallback(
    (from: string | null) =>
      client
        .query(api.accountTeams.list, { paginationOpts: { cursor: from, numItems: PAGE } })
        .then(result => {
          const data = {
            teams: [...(from && last.current ? last.current.teams : []), ...result.page],
            more: !result.isDone,
          };
          cursor.current = result.isDone ? null : result.continueCursor;
          last.current = data;
          setRead({ state: 'ok', data });
        })
        .catch(() => setRead({ state: 'failed', last: last.current })),
    [client],
  );
  const first = useCallback(() => void page(null), [page]);
  useEffect(() => {
    first();
    const shown = () => {
      if (document.visibilityState === 'visible') first();
    };
    document.addEventListener('visibilitychange', shown);
    return () => document.removeEventListener('visibilitychange', shown);
  }, [first]);
  return { read, retry: first, showMore: () => void (cursor.current && page(cursor.current)) };
}

export default function AccountPeople(_props: AccountProps) {
  const client = useConvex();
  const { read, retry, showMore } = useAccountTeams();
  const actions: TeamActions = {
    create: async name => {
      await client.mutation(api.teams.create, { name, operationId: crypto.randomUUID() }).catch(error => {
        throw new Error(said(error));
      });
      retry();
    },
    add: async (id, email) => {
      await client.action(api.teamActions.addByEmail, { id, email }).catch(error => {
        throw new Error(said(error));
      });
      retry();
    },
    remove: async (id, member) => {
      await client.mutation(api.teams.removeMember, { id, member }).catch(error => {
        throw new Error(said(error));
      });
      retry();
    },
  };
  return (
    <PeopleView
      read={read}
      retry={retry}
      showMore={showMore}
      actions={actions}
      invitations={<Invitations />}
    />
  );
}

const trail = [
  { label: 'Account', href: hrefFor({ frame: 'account', place: 'projects' }) },
  { label: 'People and teams' },
];

export function PeopleView({
  read,
  retry,
  showMore,
  actions,
  invitations,
}: {
  read: Read;
  retry: () => void;
  showMore?: () => void;
  actions: TeamActions;
  invitations?: ReactNode;
}) {
  const data = read.state === 'ok' ? read.data : read.state === 'failed' ? read.last : undefined;
  const sentence = data
    ? teamsSentence(data)
    : read.state === 'failed'
      ? 'Your teams could not be read.'
      : 'Loading…';
  return (
    <div className="account-people">
      <Head trail={trail} sentence={sentence} />
      {invitations}
      {read.state === 'failed' ? (
        <div className="notice" role="status">
          <span>Your teams could not be read just now. What was last shown stays here.</span>
          <Key size="sm" onClick={retry}>
            Retry
          </Key>
        </div>
      ) : null}
      {!data ? (
        read.state === 'loading' ? (
          <div className="sk-rows" aria-busy="true" aria-label="Loading your teams">
            <div className="sk" />
            <div className="sk" />
          </div>
        ) : null
      ) : (
        <Region
          title="Teams"
          weight="watch"
          count={data.teams.length}
          hint={data.more ? `${data.teams.length.toLocaleString()} shown` : undefined}
        >
          {data.teams.length ? (
            data.teams.map(team => <TeamLine key={team.id} team={team} actions={actions} />)
          ) : (
            <p className="quietline">You are not in a team yet.</p>
          )}
          {data.more ? (
            <div className="quietline people-more">
              <span>{data.teams.length.toLocaleString()} shown; you are in more teams.</span>
              {showMore ? (
                <Key size="sm" onClick={showMore}>
                  Show {PAGE.toLocaleString()} more
                </Key>
              ) : null}
            </div>
          ) : null}
        </Region>
      )}
      {data ? <CreateTeam create={actions.create} /> : null}
    </div>
  );
}

/** A form's busy flag and the server's answer, with the field cleared on success. */
function useSubmit(run: (value: string) => Promise<void>) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = value.trim();
    if (!text || busy) return;
    setBusy(true);
    setProblem('');
    run(text)
      .then(() => setValue(''))
      .catch((error: Error) => setProblem(error.message))
      .finally(() => setBusy(false));
  };
  return { value, setValue, busy, problem, submit };
}

function TeamLine({ team, actions }: { team: TeamRow; actions: TeamActions }) {
  const owns = team.role === 'owner';
  const add = useSubmit(email => actions.add(team.id, email));
  const [removing, setRemoving] = useState('');
  const [problem, setProblem] = useState('');
  const remove = (key: string) => {
    setRemoving(key);
    setProblem('');
    actions
      .remove(team.id, key)
      .catch((error: Error) => setProblem(error.message))
      .finally(() => setRemoving(''));
  };
  return (
    <Row className="team" weight="watch" cols="minmax(0, 1fr)">
      <div className="team-body">
        <span className="team-name">
          <span className="ttl" dir="auto" translate="no">
            {team.name}
          </span>
          <span className="meta">
            <span>{teamMeta(team)}</span>
            {!owns && team.ownerHandle ? (
              <span className="team-owner">
                Owner <Who handle={team.ownerHandle} />
              </span>
            ) : null}
          </span>
        </span>
        <ul className="team-members" aria-label={`Members of ${team.name}`}>
          {team.members.map((member, index) => (
            <li key={member.key ?? `${member.handle ?? 'unnamed'}-${index}`}>
              {member.handle ? (
                <Who handle={member.handle} />
              ) : (
                <span className="t2">An account with no handle</span>
              )}
              {member.you ? (
                <span className="t2">you</span>
              ) : member.owner ? (
                <span className="t2">owner</span>
              ) : null}
              {owns && member.key && !member.owner ? (
                <Key
                  size="sm"
                  kind="ghost"
                  disabled={removing === member.key}
                  aria-label={`Remove ${member.handle ?? 'this member'} from ${team.name}`}
                  onClick={() => remove(member.key!)}
                >
                  Remove
                </Key>
              ) : null}
            </li>
          ))}
          {team.more ? <li className="t2">and more</li> : null}
        </ul>
        {owns ? (
          <form className="team-add" onSubmit={add.submit} aria-busy={add.busy}>
            <label className="f">
              Add a member by their verified email
              <input
                className="inp"
                type="email"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                aria-invalid={add.problem ? true : undefined}
                value={add.value}
                onChange={event => add.setValue(event.target.value)}
              />
              {add.problem ? (
                <span className="err" role="alert">
                  {add.problem}
                </span>
              ) : null}
            </label>
            <Key size="sm" type="submit" disabled={add.busy}>
              Add
            </Key>
          </form>
        ) : null}
        {problem ? (
          <p className="notice" role="alert">
            {problem}
          </p>
        ) : null}
      </div>
    </Row>
  );
}

function CreateTeam({ create }: { create: (name: string) => Promise<void> }) {
  const form = useSubmit(create);
  return (
    <section className="region quiet team-create" aria-label="New team">
      <form className="team-add" onSubmit={form.submit} aria-busy={form.busy}>
        <label className="f">
          Start a team
          <input
            className="inp"
            autoComplete="off"
            placeholder="Team name…"
            aria-invalid={form.problem ? true : undefined}
            value={form.value}
            onChange={event => form.setValue(event.target.value)}
          />
          {form.problem ? (
            <span className="err" role="alert">
              {form.problem}
            </span>
          ) : null}
        </label>
        <Key size="sm" type="submit" disabled={form.busy}>
          Create
        </Key>
      </form>
    </section>
  );
}
