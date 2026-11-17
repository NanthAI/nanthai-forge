// SPDX-License-Identifier: Apache-2.0
// Who did it, until the shared ds component from Item 41514fee lands: the kind mark (a filled square for a person, an
// outlined one for an agent run), the public handle, the kind as a word, and for an agent run the model its session
// declared ("model not declared" when it declared none). Public identities only (DESIGN.md rule 32): a handle or a
// run name, never a name, an email or a machine. One line; the full text stays in the title when it is cut.
import { Avatar } from '../../ds';
import type { Writer } from './model';

export function By({ by }: { by: Writer }) {
  if (by.kind === 'forge')
    return (
      <span className="by-who" data-kind="forge" title="Forge">
        <span className="av si" aria-hidden="true">
          f
        </span>
        <b>Forge</b>
      </span>
    );
  const said = by.kind === 'agent' ? (by.model ?? 'model not declared') : '';
  const title = [by.label || (by.kind === 'agent' ? 'an agent run' : 'a person'), by.kind, said]
    .filter(Boolean)
    .join(' · ');
  // Avatar reads `person/run` as an agent; a run whose person is hidden still gets the outlined square.
  const mark = by.kind === 'agent' && !by.label.includes('/') ? `/${by.label}` : by.label || '?';
  return (
    <span className="by-who" data-kind={by.kind} title={title}>
      <Avatar handle={mark} />
      {by.label ? (
        <span className="mono name" dir="auto" translate="no">
          {by.label}
        </span>
      ) : (
        <span className="t2">a person</span>
      )}
      <span className="kind">{by.kind}</span>
      {by.kind === 'agent' ? (
        by.model ? (
          <span className="mono model" translate="no">
            {by.model}
          </span>
        ) : (
          <span className="model nd">model not declared</span>
        )
      ) : null}
      {by.verified ? null : (
        <span className="t3" title="Typed by the writer; Forge did not record who wrote it">
          not verified
        </span>
      )}
    </span>
  );
}
