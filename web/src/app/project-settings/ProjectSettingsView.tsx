// SPDX-License-Identifier: Apache-2.0
// Settings > Project, as one view over what the page read (Item 966cb821). The owner renames the project and moves it to
// the trash; everyone else reads the facts. Layout follows the other Settings places: a head, then regions of rows.
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Key, Region, Row } from '../../ds';
import { hostedError } from '../../snapshot';
import { Head } from '../Place';
import { MoveToTrash } from '../trash/MoveToTrash';
import { MakePrivate, MakePublic } from './VisibilitySheets';
import '../trash/trash.css';
import './project-settings.css';
import {
  createdWords,
  planWords,
  renameProblem,
  sentence,
  visibilityWords,
  type ProjectFacts,
} from './project-model';

type Crumb = { label: string; href?: string };
/** One opened confirmation: its own operation id and the revision the person saw, kept for retries of that sheet only. */
export type VisibilityChange = {
  visibility: ProjectFacts['visibility'];
  confirm?: string;
  operationId: string;
  expectedRevision: number;
};
export type RenameInput = { name: string; slug: string; operationId: string; expectedRevision: number };

export function ProjectSettingsView({
  facts,
  owner,
  trail,
  lanes,
  now,
  rename,
  moveToTrash,
  setVisibility,
  setPlanVisibility,
  extra,
}: {
  facts: ProjectFacts;
  owner: boolean;
  trail: Crumb[];
  lanes: { n: number; atLeast: boolean } | null;
  now: number;
  rename: (input: RenameInput) => Promise<void>;
  moveToTrash: () => Promise<void>;
  /** Owner person only: the server refuses anyone else. Going public carries the typed name. */
  setVisibility: (change: VisibilityChange) => Promise<void>;
  /** Owner person only: the server refuses anyone else. One reversible write; repeating it changes nothing. */
  setPlanVisibility: (plan: ProjectFacts['planVisibility'], operationId: string) => Promise<void>;
  /** Further regions of the page (backups, transfer, imports), after the lifecycle. */
  extra?: ReactNode;
}) {
  const [moving, setMoving] = useState(false);
  const [changing, setChanging] = useState<{
    to: ProjectFacts['visibility'];
    operationId: string;
    revision: number;
  } | null>(null);
  return (
    <div className="project-settings">
      <Head trail={trail} sentence={sentence(facts, owner)} />
      <Region title="The project" weight="ref">
        <Fact label="Name">
          <span dir="auto" translate="no">
            {facts.name}
          </span>
        </Fact>
        <Fact label="Address">
          <span className="mono" translate="no">
            {facts.handle}/{facts.slug ?? facts.name}
          </span>
        </Fact>
        <Fact label="Visibility">{visibilityWords(facts.visibility)}</Fact>
        <Fact label="Plan">{planWords(facts)}</Fact>
        <Fact label="Owner">
          <span className="mono" translate="no">
            @{facts.handle}
          </span>
        </Fact>
        <Fact label="Created">{createdWords(facts.createdAt)}</Fact>
      </Region>
      {owner ? <RenameForm facts={facts} rename={rename} /> : null}
      {owner ? (
        <Region title="Visibility" weight="ref">
          <Row cols="minmax(0, 1fr) auto">
            <span className="nm">
              <span className="ttl">
                {facts.visibility === 'public' ? 'Make this project private' : 'Make this project public'}
              </span>
              <span className="meta">
                {facts.visibility === 'public'
                  ? 'Only you and the people you invited can see it. Its public pages and listing stop.'
                  : 'Anyone can read its source, history, Lanes and plan. Only you and the people you invite can change it.'}
              </span>
            </span>
            <Key
              size="sm"
              onClick={() =>
                setChanging({
                  to: facts.visibility === 'public' ? 'private' : 'public',
                  operationId: crypto.randomUUID(),
                  revision: facts.revision,
                })
              }
            >
              {facts.visibility === 'public' ? 'Make private' : 'Make public'}
            </Key>
          </Row>
        </Region>
      ) : null}
      {owner ? <PlanSwitch facts={facts} set={setPlanVisibility} /> : null}
      {owner ? (
        <Region title="Trash" weight="ref">
          <Row cols="minmax(0, 1fr) auto">
            <span className="nm">
              <span className="ttl">Move this project to the trash</span>
              <span className="meta">
                Everyone loses access now. It stays in the trash for 90 days and can be restored from
                Projects, Trash.
              </span>
            </span>
            <Key size="sm" onClick={() => setMoving(true)}>
              Move to trash
            </Key>
          </Row>
        </Region>
      ) : null}
      {extra}
      {changing?.to === 'public' ? (
        <MakePublic
          name={facts.name}
          apply={async typed => {
            await setVisibility({
              visibility: 'public',
              confirm: typed,
              operationId: changing.operationId,
              expectedRevision: changing.revision,
            });
            setChanging(null);
          }}
          close={() => setChanging(null)}
        />
      ) : null}
      {changing?.to === 'private' ? (
        <MakePrivate
          name={facts.name}
          apply={async () => {
            await setVisibility({
              visibility: 'private',
              operationId: changing.operationId,
              expectedRevision: changing.revision,
            });
            setChanging(null);
          }}
          close={() => setChanging(null)}
        />
      ) : null}
      {moving ? (
        <MoveToTrash
          name={facts.name}
          lanes={lanes}
          now={now}
          move={moveToTrash}
          close={() => setMoving(false)}
        />
      ) : null}
    </div>
  );
}

/** Who reads the plan (Items, Initiatives, comments) of a public project. One write, safe to repeat; the page rereads. */
function PlanSwitch({
  facts,
  set,
}: {
  facts: ProjectFacts;
  set: (plan: ProjectFacts['planVisibility'], operationId: string) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const members = facts.planVisibility === 'members';
  // One operation id per change, kept until it succeeds, so a retry after a lost reply reconciles.
  const attempt = useRef<{ plan: ProjectFacts['planVisibility']; id: string } | null>(null);
  const change = async () => {
    setPending(true);
    setError('');
    try {
      const plan = members ? 'public' : 'members';
      attempt.current = attempt.current?.plan === plan ? attempt.current : { plan, id: crypto.randomUUID() };
      await set(plan, attempt.current.id);
      attempt.current = null;
    } catch (failure) {
      setError(hostedError(failure));
    } finally {
      setPending(false);
    }
  };
  return (
    <Region title="Plan" weight="ref">
      <Row cols="minmax(0, 1fr) auto">
        <span className="nm">
          <span className="ttl">{members ? 'Make the plan public' : 'Keep the plan to members'}</span>
          <span className="meta">
            {members
              ? 'Visitors to this public project can read its Items, Initiatives and comments again.'
              : 'Only you and the people you invite can read the Items, Initiatives and comments.'}
            {facts.visibility === 'private'
              ? ' The project is private, so this applies once it is public.'
              : ''}
          </span>
        </span>
        <Key size="sm" disabled={pending} onClick={() => void change()}>
          {members ? 'Make public' : 'Members only'}
        </Key>
      </Row>
      {error ? (
        <p className="pf" role="alert">
          {error}
        </p>
      ) : null}
    </Region>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Row cols="140px minmax(0, 1fr)" className="fact">
      <span className="t2">{label}</span>
      <span className="val">{children}</span>
    </Row>
  );
}

/** Name and address. One operation id per attempt is kept until it succeeds, so a retry after a lost reply reconciles. */
function RenameForm({
  facts,
  rename,
}: {
  facts: ProjectFacts;
  rename: (input: RenameInput) => Promise<void>;
}) {
  const [name, setName] = useState(facts.name);
  const [slug, setSlug] = useState(facts.slug ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const attempt = useRef<RenameInput | null>(null);
  const id = useId();
  const problem = renameProblem(name, slug, facts);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (problem && !attempt.current) return;
    // The whole request is fixed on the first press and replayed verbatim, revision included.
    const input = attempt.current ?? {
      name: name.trim(),
      slug,
      operationId: crypto.randomUUID(),
      expectedRevision: facts.revision,
    };
    attempt.current = input;
    setPending(true);
    setError('');
    setSaved(false);
    try {
      await rename(input);
      attempt.current = null;
      setSaved(true);
    } catch (failure) {
      setError(`${hostedError(failure)} Save again to retry the same change.`);
    } finally {
      setPending(false);
    }
  };
  return (
    <Region title="Name and address" weight="ref">
      <form className="rename" onSubmit={submit}>
        <label className="f" htmlFor={`${id}-name`}>
          <span>Project name</span>
          <input
            id={`${id}-name`}
            className="inp"
            value={name}
            required
            disabled={pending || !!attempt.current}
            onChange={event => setName(event.target.value)}
          />
        </label>
        <label className="f" htmlFor={`${id}-slug`}>
          <span>Address</span>
          <input
            id={`${id}-slug`}
            className="inp mono"
            value={slug}
            required
            maxLength={100}
            autoCapitalize="off"
            spellCheck={false}
            disabled={pending || !!attempt.current}
            onChange={event => setSlug(event.target.value)}
          />
          <span className="help" translate="no">
            /{facts.handle}/{slug || '…'}. Links to its 10 most recent previous addresses keep working.
          </span>
        </label>
        {error ? (
          <p className="pf" role="alert">
            {error}
          </p>
        ) : null}
        {saved && !error ? (
          <p className="pf" role="status">
            Saved.
          </p>
        ) : null}
        <div className="btns">
          <Key type="submit" disabled={pending || (!attempt.current && !!problem)}>
            {pending ? 'Saving…' : attempt.current ? 'Retry the same change' : 'Save name and address'}
          </Key>
          {attempt.current ? (
            <Key
              kind="ghost"
              disabled={pending}
              onClick={() => {
                attempt.current = null;
                setName(facts.name);
                setSlug(facts.slug ?? '');
                setError('');
              }}
            >
              Use the current name
            </Key>
          ) : null}
          {problem && !attempt.current && (name !== facts.name || slug !== (facts.slug ?? '')) ? (
            <span className="meta">{problem}</span>
          ) : null}
        </div>
      </form>
    </Region>
  );
}
