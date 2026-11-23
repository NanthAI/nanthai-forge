// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { Avatar } from '../../ds';
import { RecordedWho } from '../RecordedWho';
import type { WhoProject } from '../who-links';
import type { Writer } from './model';

export function By({ by, project }: { by: Writer; project?: WhoProject | undefined }) {
  if (by.kind === 'forge')
    return (
      <span className="by-who" data-kind="forge">
        <span className="av si" aria-hidden="true">
          f
        </span>
        <b>Forge</b>
      </span>
    );
  const hiddenAgent = by.kind === 'agent' && !by.label.includes('/');
  const handle = hiddenAgent ? `/${by.label}` : by.label;
  return (
    <span className="by-who" data-kind={by.kind}>
      {by.verified ? (
        <RecordedWho handle={handle} model={by.model} project={project} />
      ) : (
        <>
          <Avatar handle={by.label || '?'} />
          {by.label ? (
            <span className="mono name" dir="auto">
              {by.label}
            </span>
          ) : (
            <span className="t2">a person</span>
          )}
        </>
      )}
      {!by.verified && by.label ? (
        <span className="t3" title="Typed by the writer; Forge did not record who wrote it">
          not verified
        </span>
      ) : null}
    </span>
  );
}
