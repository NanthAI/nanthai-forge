// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { Band, Key } from '../../ds';

export type ReadInitiativeWork = (initiativeId: string) => Promise<string>;

type Work =
  | { role: false }
  | {
      role: true;
      openLanes: number;
      openAtLeast: boolean;
      landings: number | null;
      files: number | null;
      missingFiles: number;
    };

const count = (value: number | null | undefined, partial = false) =>
  value == null ? '—' : `${value.toLocaleString()}${partial ? '+' : ''}`;

export function InitiativeWork({ initiativeId, read }: { initiativeId: string; read: ReadInitiativeWork }) {
  const [work, setWork] = useState<Work | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, retry] = useState(0);
  useEffect(() => {
    let current = true;
    read(initiativeId)
      .then(raw => JSON.parse(raw) as Work)
      .then(
        result => {
          if (current) setWork(result);
        },
        () => {
          if (current) setFailed(true);
        },
      );
    return () => {
      current = false;
    };
  }, [initiativeId, read, attempt]);

  if (work && !work.role) return null;
  return (
    <>
      <Band title="Work" />
      <dl className="kv" aria-busy={!work && !failed}>
        <dt>Lanes open</dt>
        <dd>{count(work?.openLanes, work?.openAtLeast)}</dd>
        <dt>Landings</dt>
        <dd>{count(work?.landings)}</dd>
        <dt>Files touched</dt>
        <dd>{count(work?.files, Boolean(work?.missingFiles))}</dd>
      </dl>
      {failed ? (
        <div className="plan-about">
          <p role="status">Work could not be loaded.</p>
          <Key
            size="sm"
            onClick={() => {
              setFailed(false);
              retry(previous => previous + 1);
            }}
          >
            Retry
          </Key>
        </div>
      ) : null}
    </>
  );
}
