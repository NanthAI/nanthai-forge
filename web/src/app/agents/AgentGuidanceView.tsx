// SPDX-License-Identifier: Apache-2.0
// Settings > Agents as one view over what the page read (Item f2ee8381). Two texts, each saved on its own: the project's
// (the owner or a guidance maintainer writes it; everyone else reads it) and the viewer's own. Layout follows the other
// Settings places: a head, then regions.
import { useId, useRef, useState, type FormEvent } from 'react';
import { Key, Region } from '../../ds';
import { hostedError } from '../../snapshot';
import { Head } from '../Place';
import './agents.css';
import {
  attemptFor,
  GUIDANCE_LIMIT,
  sentence,
  type Attempt,
  type Guidance,
  type Scope,
} from './guidance-model';

type Crumb = { label: string; href?: string };

export function AgentGuidanceView({
  guidance,
  trail,
  save,
}: {
  guidance: Guidance;
  trail: Crumb[];
  /** One retry-safe write; the operation id is the same on every replay of one change. */
  save: (input: Attempt) => Promise<void>;
}) {
  return (
    <div className="agent-guidance">
      <Head trail={trail} sentence={sentence(guidance.projectEditable)} />
      <GuidanceRegion
        scope="project"
        title="For this project"
        hint="Included in every agent’s briefing, after the repo’s AGENTS.md or CLAUDE.md."
        value={guidance.project}
        editable={guidance.projectEditable}
        save={save}
      />
      <GuidanceRegion
        scope="personal"
        title="Just for me"
        hint="Only for agents you start, in every project."
        value={guidance.personal}
        editable
        save={save}
      />
    </div>
  );
}

function GuidanceRegion({
  scope,
  title,
  hint,
  value,
  editable,
  save,
}: {
  scope: Scope;
  title: string;
  hint: string;
  value: string;
  editable: boolean;
  save: (input: Attempt) => Promise<void>;
}) {
  const [text, setText] = useState(value);
  const [saved, setSaved] = useState(value);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const attempt = useRef<Attempt | null>(null);
  const id = useId();
  const dirty = text !== saved;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!dirty || pending) return;
    const input = attemptFor(attempt.current, scope, text);
    attempt.current = input;
    setPending(true);
    setError('');
    setDone(false);
    try {
      await save(input);
      attempt.current = null;
      setSaved(input.text);
      setDone(true);
    } catch (failure) {
      setError(`${hostedError(failure)} Save again to retry the same change.`);
    } finally {
      setPending(false);
    }
  };
  return (
    <Region title={title} weight="ref" hint={editable ? undefined : 'read only'}>
      <form className="guide" onSubmit={submit}>
        <div className="field">
          <textarea
            id={`${id}-text`}
            aria-label={title}
            className="inp"
            rows={6}
            maxLength={GUIDANCE_LIMIT}
            value={text}
            readOnly={!editable}
            aria-describedby={`${id}-hint`}
            placeholder={
              editable
                ? 'For example: keep changes small, run npm run verify before finishing, never touch generated files.'
                : 'No guidance has been written for this project.'
            }
            onChange={event => {
              setText(event.target.value);
              setDone(false);
            }}
          />
          <span className="help" id={`${id}-hint`}>
            {hint}
          </span>
        </div>
        {error ? (
          <p className="pf" role="alert">
            {error}
          </p>
        ) : null}
        {done && !error && !dirty ? (
          <p className="pf" role="status">
            Saved.
          </p>
        ) : null}
        <div className="btns">
          {editable ? (
            <Key type="submit" kind={dirty ? 'primary' : undefined} disabled={!dirty || pending}>
              {pending ? 'Saving…' : attempt.current ? 'Retry the same change' : 'Save'}
            </Key>
          ) : (
            <span className="meta">Only the owner or a guidance maintainer can change this.</span>
          )}
          <span className="meta tnum">
            {text.length.toLocaleString('en-GB')} / {GUIDANCE_LIMIT.toLocaleString('en-GB')}
          </span>
        </div>
      </form>
    </Region>
  );
}
