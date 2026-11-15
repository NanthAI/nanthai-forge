// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from 'react';
import { useConvex } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import type { AutonomyPolicy, PolicyWrite } from '../../../src/autonomy-policy';
import { Button, Panel } from '../ui/primitives';
import { UncheckedLandingHistory } from './UncheckedLandingHistory';
import { ErrorToast } from '../ui/Toast';
import { hostedError } from '../snapshot';
type Selection = NonNullable<AutonomyPolicy['acceptance']['withoutCheck']>;
const initial: Selection = { mode: 'owner', people: [], teams: [] };
const options = [
  ['owner', 'Owner only'],
  ['selected', 'Owner and chosen people or teams'],
  ['writers', 'Owner and all write members'],
] as const;

/** Finite reads when opened or picked; no subscription or idle requests. Policy history and Undo
 * use the same set-policy mutation as every other acceptance setting. */
export function UncheckedLanding({ projectId, owner }: { projectId: Id<'hostedProjects'>; owner: boolean }) {
  const client = useConvex();
  const [policy, setPolicy] = useState<AutonomyPolicy | null>(null);
  const [draft, setDraft] = useState(initial);
  const [person, setPerson] = useState('');
  const [teams, setTeams] = useState<{ id: Id<'teams'>; name: string }[]>([]);
  const [teamCursor, setTeamCursor] = useState<string | null | undefined>(null);
  const [teamNames, setTeamNames] = useState<Record<string, string>>({});
  const [choosingTeam, setChoosingTeam] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [undo, setUndo] = useState<Selection | null>(null);
  const pending = useRef<PolicyWrite | null>(null);
  useEffect(() => {
    let live = true;
    void client
      .query(api.projectUncheckedLandingSettings.read, { projectId })
      .then(value => {
        if (live) {
          setPolicy(value.policy);
          setDraft(value.policy.acceptance.withoutCheck ?? initial);
          setTeamNames(value.teamNames);
        }
      })
      .catch(e => {
        if (live) setError(hostedError(e));
      });
    return () => {
      live = false;
    };
  }, [client, projectId]);
  const edit = (value: Selection) => {
    setDraft(value);
    setSaved(false);
  };
  const pickPerson = async () => {
    setBusy(true);
    setError('');
    try {
      const value = await client.query(api.projectUncheckedLanding.pickPerson, { projectId, handle: person });
      edit({ ...draft, people: [...new Set([...draft.people, value.handle])] });
      setPerson('');
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setBusy(false);
    }
  };
  const loadTeams = async () => {
    if (teamCursor === undefined) return;
    setBusy(true);
    setError('');
    setChoosingTeam(true);
    try {
      const page = await client.query(api.projectUncheckedLandingSettings.teams, {
        projectId,
        paginationOpts: { cursor: teamCursor, numItems: 20 },
      });
      setTeams(value => [...value, ...page.page]);
      setTeamNames(value => ({
        ...value,
        ...Object.fromEntries(page.page.map(team => [team.id, team.name])),
      }));
      setTeamCursor(page.isDone ? undefined : page.continueCursor);
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setBusy(false);
    }
  };
  const apply = async (selection: Selection) => {
    if (!policy) return;
    pending.current ??= {
      action: 'set-policy',
      operationId: crypto.randomUUID(),
      expectedPolicy: policy,
      acceptance: { withoutCheck: selection },
    };
    setBusy(true);
    setError('');
    try {
      const result = await client.mutation(api.projectAutonomy.set, {
        projectId,
        command: JSON.stringify(pending.current),
      });
      if (result.rule === 'held')
        throw new Error(
          ('approval' in result ? result.approval?.next : undefined) ??
            'This setting change is awaiting approval.',
        );
      setUndo(policy.acceptance.withoutCheck ?? initial);
      setPolicy(result.policy);
      setDraft(result.policy.acceptance.withoutCheck ?? initial);
      pending.current = null;
      setSaved(true);
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="Who can land without a check">
      {!policy ? (
        <p role="status">Reading landing policy…</p>
      ) : (
        <>
          <fieldset disabled={!owner || busy || !!pending.current} className="fx-policy-fields">
            <legend className="fx-sr-only">Who can land without a check</legend>
            {options.map(([mode, label]) => (
              <label className="fx-setting" key={mode}>
                <span>
                  <input
                    type="radio"
                    name="unchecked-landing"
                    value={mode}
                    checked={draft.mode === mode}
                    onChange={() => edit({ ...draft, mode })}
                  />{' '}
                  {label}
                </span>
              </label>
            ))}
            {draft.mode === 'selected' && (
              <>
                <ul className="reader-list" aria-label="Chosen people">
                  {draft.people.map(value => (
                    <li key={value}>
                      <span>@{value.replace(/^@/, '')}</span>
                      {owner && (
                        <Button
                          onClick={() =>
                            edit({ ...draft, people: draft.people.filter(item => item !== value) })
                          }
                          aria-label={`Remove @${value}`}
                        >
                          Remove
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
                {owner && (
                  <div className="fx-setting">
                    <label>
                      Forge handle{' '}
                      <input
                        aria-label="Forge handle"
                        value={person}
                        placeholder="@handle"
                        onChange={event => setPerson(event.target.value)}
                      />
                    </label>
                    <Button disabled={!person.trim()} onClick={() => void pickPerson()}>
                      Add person
                    </Button>
                  </div>
                )}
                <ul className="reader-list" aria-label="Chosen teams">
                  {draft.teams.map(value => (
                    <li key={value}>
                      <span>{teamNames[value] ?? value}</span>
                      {owner && (
                        <Button
                          onClick={() =>
                            edit({ ...draft, teams: draft.teams.filter(item => item !== value) })
                          }
                          aria-label={`Remove team ${teamNames[value] ?? value}`}
                        >
                          Remove
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
                {owner && (
                  <>
                    {!choosingTeam && <Button onClick={() => void loadTeams()}>Choose a team</Button>}
                    {choosingTeam && (
                      <div className="fx-setting">
                        <label>
                          Team{' '}
                          <select
                            aria-label="Team"
                            value=""
                            onChange={event => {
                              if (event.target.value)
                                edit({ ...draft, teams: [...new Set([...draft.teams, event.target.value])] });
                            }}
                          >
                            <option value="">Choose by team name</option>
                            {teams
                              .filter(team => !draft.teams.includes(team.id))
                              .map(team => (
                                <option key={team.id} value={team.id}>
                                  {team.name}
                                </option>
                              ))}
                          </select>
                        </label>
                        {teamCursor !== undefined && (
                          <Button onClick={() => void loadTeams()}>More teams</Button>
                        )}
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </fieldset>
          {owner && (
            <div className="fx-settings-save">
              <span role="status">{saved ? 'Landing policy saved.' : ''}</span>
              {undo && (
                <Button disabled={busy || !!pending.current} onClick={() => void apply(undo)}>
                  Undo
                </Button>
              )}
              {pending.current && (
                <Button
                  disabled={busy}
                  onClick={() => {
                    pending.current = null;
                    setDraft(policy.acceptance.withoutCheck ?? initial);
                    setError('');
                  }}
                >
                  Discard
                </Button>
              )}
              <Button
                variant="primary"
                disabled={
                  busy ||
                  (!pending.current &&
                    JSON.stringify(draft) === JSON.stringify(policy.acceptance.withoutCheck ?? initial))
                }
                onClick={() => void apply(draft)}
              >
                {busy ? 'Saving…' : pending.current ? 'Retry save' : 'Save landing policy'}
              </Button>
            </div>
          )}
        </>
      )}
      {owner && policy && (
        <UncheckedLandingHistory
          projectId={projectId}
          disabled={busy || !!pending.current}
          revision={policy}
          undo={value => apply(value)}
        />
      )}
      {error && <ErrorToast>{error}</ErrorToast>}
    </Panel>
  );
}
