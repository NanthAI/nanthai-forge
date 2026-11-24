// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// An Item's versions (Item 4c9e961e): compare any two by line and word, and restore one, which writes a new version
// with that title and body through the batch call (retry-safe, with the 10-second Undo); no version is ever removed.
// The server allows it to the project owner only, and refuses it when the Item changed meanwhile. Mounted only while
// the sheet is open, so its pages are read on demand and an idle Item page reads nothing more: the newest 100 versions,
// and older ones only when asked (Item 686ecdde). Text is shown as plain text, never rendered.
import { useState } from 'react';
import type { Id } from '../../../../convex/_generated/dataModel';
import { Key, Sheet } from '../../ds';
import type { PlanningItem } from '../../../../src/work-planning-types';
import { useResolvedWorkValue, useWorkIndex, useWorkPage } from '../../hosted-work-index';
import { lineDiff } from './diff';
import type { BatchOutcome } from './batch';
import type { BatchWrite } from '../../../../src/planning-batch';

export function Versions({
  projectId,
  itemId,
  pair,
  restore: apply,
  onOpenChange,
}: {
  projectId: Id<'hostedProjects'>;
  itemId: string;
  pair?: readonly [number, number | undefined] | undefined;
  /** Present only when the reader may edit: runs the restore and shows its Undo. */
  restore: ((writes: BatchWrite[], words: string) => Promise<BatchOutcome>) | undefined;
  onOpenChange: (open: boolean) => void;
}) {
  const { workspace } = useWorkIndex(projectId);
  const versions = useWorkPage<PlanningItem>(projectId, workspace, 'planningVersions', itemId);
  const ordered = [...versions.records].sort((a, b) => b.version - a.version);
  const latest = ordered[0];
  const [left, setLeft] = useState<number | null>(pair?.[0] ?? null);
  const [right, setRight] = useState<number | null>(pair?.[1] ?? null);
  const older = ordered.find(entry => entry.version === (left ?? ordered[1]?.version)) ?? null;
  const newer = ordered.find(entry => entry.version === (right ?? latest?.version)) ?? null;
  const a = useResolvedWorkValue(projectId, workspace, 'planningVersions', older);
  const b = useResolvedWorkValue(projectId, workspace, 'planningVersions', newer);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const current = useResolvedWorkValue(projectId, workspace, 'planningVersions', latest ?? null);
  const restore = async () => {
    if (!a || !latest || !current || !apply) return;
    setBusy(true);
    setError('');
    try {
      const outcome = await apply(
        [
          {
            action: 'put-planning-item',
            itemId,
            expectedVersion: latest.version,
            title: a.title,
            body: a.body,
            reason: `Restored version ${a.version}`,
          },
        ],
        `Restored version ${a.version} as version ${latest.version + 1}.`,
      );
      const refused = outcome.results.find(result => result.outcome === 'refused');
      if (!refused) onOpenChange(false);
      else
        setError(
          refused.code === 'ITEM_CHANGED'
            ? 'Someone changed this Item meanwhile. Nothing was overwritten; compare again with their version.'
            : (refused.message ?? 'Forge could not restore it; nothing changed.'),
        );
    } catch {
      setError('Forge could not restore it; nothing changed.');
    } finally {
      setBusy(false);
    }
  };
  const pick = (value: number | null, set: (n: number) => void, label: string) => (
    <label>
      <span>{label}</span>
      <select className="inp" value={value ?? ''} onChange={event => set(Number(event.target.value))}>
        {ordered.map(entry => (
          <option key={entry.version} value={entry.version}>
            Version {entry.version}, {entry.at.slice(0, 10)}
            {entry.reason ? `, ${entry.reason.slice(0, 40)}` : ''}
          </option>
        ))}
      </select>
    </label>
  );
  const diff = a && b ? lineDiff(`${a.title}\n\n${a.body}`, `${b.title}\n\n${b.body}`) : [];
  return (
    <Sheet
      open
      onOpenChange={onOpenChange}
      title={older && newer ? `Version ${older.version} beside version ${newer.version}` : 'Versions'}
      footer={
        <>
          <Key onClick={() => onOpenChange(false)}>Close</Key>
          {apply && a && latest && a.version !== latest.version ? (
            <Key
              kind="primary"
              onClick={() => void restore()}
              disabled={busy || !current}
              title="Adds a version with this text; no version is removed"
            >
              Restore version {a.version}
            </Key>
          ) : null}
        </>
      }
    >
      <div className="plan-capture">
        {versions.initialLoading ? (
          <p className="t2" aria-busy="true">
            Reading versions…
          </p>
        ) : ordered.length < 2 ? (
          versions.complete ? (
            <p className="t2">This Item has one version; there is nothing to compare yet.</p>
          ) : null
        ) : (
          <>
            <div className="plan-pair">
              {pick(older?.version ?? null, setLeft, 'Older')}
              {pick(newer?.version ?? null, setRight, 'Newer')}
            </div>
            <pre className="plan-diff" aria-label="Changes between the two versions">
              {diff.map((line, index) => (
                <span key={index} className={line.words ? `${line.kind} wd` : line.kind}>
                  {line.kind === 'old' ? '− ' : line.kind === 'new' ? '+ ' : '  '}
                  {line.words
                    ? line.words.map((part, at) =>
                        part.kind === 'same' ? (
                          part.text
                        ) : (
                          <span key={at} className="w">
                            {part.text}
                          </span>
                        ),
                      )
                    : line.text}
                  {'\n'}
                </span>
              ))}
            </pre>
          </>
        )}
        {!versions.initialLoading && (versions.more || versions.loadingMore) ? (
          // Stays mounted while it reads, so keyboard focus is kept (a page can hold few large versions).
          <Key
            size="sm"
            onClick={() => versions.more?.()}
            aria-disabled={!versions.more}
            aria-busy={versions.loadingMore}
          >
            {versions.loadingMore ? 'Reading older versions…' : 'Read older versions'}
          </Key>
        ) : null}
        {versions.failed ? (
          <p className="pf" role="alert">
            Could not read the versions. Close and open Versions to try again.
          </p>
        ) : null}
        {error ? (
          <p className="pf" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
