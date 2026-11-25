// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Who can open them: people first with their computers inside, then machine keys. A computer's own name is shown
// only to its owner; everyone else sees its code. The page has no Remove key: a computer is taken out in a terminal.
import { Band, Region, State, Who } from '../../ds';
import { count, exact, relative, setLabel, type Overview, type OverviewSet } from './secrets-model';

type Person = NonNullable<OverviewSet['people']>['page'][number];
type Computer = Person['computers'][number];

const HOW = {
  first: 'first holder',
  code: 'added by code',
  auto: 'joined automatically · not confirmed by code, so it changes nothing',
} as const;

function ComputerRow({ computer }: { computer: Computer }) {
  return (
    <div className="row secret-dev">
      <span className="secret-dn">
        <span className="who dev">
          <span className="av si" aria-hidden="true">
            c
          </span>
          {computer.name ? <span className="quoted">“{computer.name}”</span> : null}
          <span className="dcode">{computer.code}</span>
        </span>
        <span className="sgn">
          {computer.marked ? (
            <>
              <State word="Needs you" state="waiting">
                Needs you
              </State>{' '}
              · removed, opens nothing new; taken out at the next re-key
            </>
          ) : (
            HOW[computer.how]
          )}
        </span>
      </span>
    </div>
  );
}

function PersonRows({ person, now }: { person: Person; now: number }) {
  const computers = count(person.computers.length, 'computer');
  return (
    <>
      <div className="row secret-person">
        <span className="secret-pn">
          {person.handle ? <Who handle={person.handle} /> : <span className="t3">Not reported</span>}
          <span className="sub">
            {person.left
              ? `left the project${person.leftAt ? ` ${relative(person.leftAt, now)}` : ''} · ${computers}`
              : `${person.role} · ${computers}`}
          </span>
        </span>
      </div>
      {person.computers.map(computer => (
        <ComputerRow key={computer.code} computer={computer} />
      ))}
    </>
  );
}

export function SecretsHolders({
  data,
  now,
  onMore,
  busy,
}: {
  data: Overview;
  now: number;
  onMore: (kind: 1 | 2 | 3, part: 'people') => void;
  busy: boolean;
}) {
  return (
    <Region title="Who can open them" hint="people, with their computers inside">
      {data.sets.map(set => {
        const people = set.people;
        if (!people) return null;
        const nobody = people.total === 0 && !set.machines?.length;
        const computers = people.page.reduce((n, p) => n + p.computers.length, 0);
        return (
          <div key={set.kind}>
            <Band
              title={setLabel(set.kind)}
              count={people.total}
              hint={
                people.next
                  ? `${count(people.total, 'person', 'people')} · first ${people.page.length} shown`
                  : `${count(people.total, 'person', 'people')} · ${count(computers, 'computer')}`
              }
            />
            {nobody ? (
              <p className="quietline">
                <State word="Check failed" state="failed">
                  No value
                </State>{' '}
                Nobody can open {setLabel(set.kind)}. Its {count(set.names?.total ?? 0, 'name')} stay listed;
                the owner sets each again.
              </p>
            ) : null}
            {people.page.map(person => (
              <PersonRows
                key={`${person.handle ?? ''}:${person.computers[0]?.code}`}
                person={person}
                now={now}
              />
            ))}
            {people.next ? (
              <p className="pf">
                {people.page.length} of {count(people.total, 'person', 'people')} shown ·{' '}
                <button
                  type="button"
                  className="btn sm ghost"
                  disabled={busy}
                  onClick={() => onMore(set.kind, 'people')}
                >
                  Show the next 25
                </button>
              </p>
            ) : null}
            {set.waiting?.length ? (
              <>
                <Band
                  title="Waiting"
                  count={set.waiting.length}
                  hint={`the next holder’s terminal shares ${setLabel(set.kind)}`}
                />
                {set.waiting.map(wait => (
                  <div className="row secret-dev" key={wait.code}>
                    <span className="secret-dn">
                      <span className="who dev">
                        <span className="av si" aria-hidden="true">
                          c
                        </span>
                        <span className="dcode">{wait.code}</span>
                      </span>
                      <span className="sgn">
                        {wait.handle ? <Who handle={wait.handle} /> : 'A person'} asked{' '}
                        <time title={exact(wait.at)}>{relative(wait.at, now)}</time> · every holder is told,
                        with Undo
                      </span>
                    </span>
                  </div>
                ))}
              </>
            ) : null}
            {set.machines?.map(machine => (
              <div className="row secret-person" key={machine.code}>
                <span className="secret-pn">
                  <span className="who dev">
                    <span className="av none" aria-hidden="true">
                      m
                    </span>
                    {machine.name ? (
                      <span className="quoted">“{machine.name}”</span>
                    ) : (
                      <span className="a-run mono">machine key</span>
                    )}
                    <span className="dcode">{machine.code}</span>
                  </span>
                  <span className="sub">
                    {machine.name ? 'machine key · ' : ''}for checks on your CI · added by{' '}
                    {machine.by ? `@${machine.by}` : 'someone Forge cannot name'}
                  </span>
                </span>
              </div>
            ))}
          </div>
        );
      })}
      <p className="pf">
        To take a computer out: <code className="mono">nforge secret unshare CODE</code>, then rotate what it
        could open.
      </p>
    </Region>
  );
}

export type { Overview };
