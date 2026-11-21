// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { Band, Key } from '../../ds';

export type ReadInitiativeWork = (initiativeId: string, cursor: string | null) => Promise<string>;

type Work =
  | { role: false }
  | {
      role: true;
      openLanes: number;
      openAtLeast: boolean;
      landings: string[];
      files: string[];
      missingFiles: string[];
      nextCursor: string | null;
    };

export function InitiativeWork({ initiativeId, read }: { initiativeId: string; read: ReadInitiativeWork }) {
  const [work, setWork] = useState<Work | null>(null);
  const [busy, setBusy] = useState(true);
  const [failed, setFailed] = useState(false);
  const [stale, setStale] = useState(false);
  useEffect(() => {
    let current = true;
    read(initiativeId, null)
      .then(raw => JSON.parse(raw) as Work)
      .then(
        page => {
          if (current) {
            setWork(page);
            setBusy(false);
          }
        },
        () => {
          if (current) {
            setFailed(true);
            setBusy(false);
          }
        },
      );
    return () => {
      current = false;
    };
  }, [initiativeId, read]);

  if (work && !work.role) return null;
  const load = async () => {
    setBusy(true);
    setFailed(false);
    try {
      const next = JSON.parse(await read(initiativeId, stale ? null : (work?.nextCursor ?? null))) as Work;
      setStale(false);
      if (!next.role || !work || stale) {
        setWork(next);
        return;
      }
      const previousMissing = new Set(work.missingFiles);
      const nextMissing = new Set(next.missingFiles);
      const knownFiles = new Set([
        ...work.landings.filter(id => !previousMissing.has(id)),
        ...next.landings.filter(id => !nextMissing.has(id)),
      ]);
      setWork({
        ...next,
        openLanes: work.openLanes + next.openLanes,
        openAtLeast: work.openAtLeast || next.openAtLeast,
        landings: [...new Set([...work.landings, ...next.landings])],
        files: [...new Set([...work.files, ...next.files])],
        missingFiles: [...new Set([...work.missingFiles, ...next.missingFiles])].filter(
          id => !knownFiles.has(id),
        ),
      });
    } catch (error) {
      setStale(stale || (error instanceof Error && /WORK_STALE/.test(error.message)));
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const count = (value: number | undefined, partial = false) =>
    value === undefined ? '—' : `${partial ? 'At least ' : ''}${value.toLocaleString()}`;
  const more = Boolean(work?.nextCursor);
  return (
    <>
      <Band title="Work" />
      <dl className="kv" aria-busy={busy}>
        <dt>Lanes open</dt>
        <dd>{count(work?.openLanes, more || work?.openAtLeast)}</dd>
        <dt>Landings</dt>
        <dd>{count(work?.landings.length, more)}</dd>
        <dt>Files touched</dt>
        <dd>
          {!more && work?.missingFiles.length && !work.files.length
            ? 'Unavailable'
            : count(work?.files.length, more || Boolean(work?.missingFiles.length))}
        </dd>
      </dl>
      {more || failed ? (
        <div className="plan-about">
          {failed ? <p role="status">Work could not be loaded.</p> : null}
          <Key size="sm" disabled={busy} onClick={() => void load()}>
            {failed ? 'Retry' : busy ? 'Loading more work…' : 'Show more work'}
          </Key>
        </div>
      ) : null}
    </>
  );
}
