// SPDX-License-Identifier: Apache-2.0
// An Item's versions (Item 4c9e961e): compare any two by line and restore one, which writes a new version with that
// title and body; no version is ever removed. Mounted only while the sheet is open, so its pages are read on demand
// and an idle Item page reads nothing more. Text is shown as plain text, never rendered.
import { useState } from 'react';
import type { Id } from '../../../../convex/_generated/dataModel';
import { Key, Sheet } from '../../ds';
import type { PlanningItem } from '../../../../src/work-planning-types';
import { useResolvedWorkValue, useWorkIndex, useWorkRecords } from '../../hosted-work-index';
import { lineDiff } from './diff';
import type { Put } from './Plan';

export function Versions({
  projectId,
  itemId,
  canEdit,
  put,
  onOpenChange,
  announce,
}: {
  projectId: Id<'hostedProjects'>;
  itemId: string;
  canEdit: boolean;
  put: Put;
  onOpenChange: (open: boolean) => void;
  announce: (text: string) => void;
}) {
  const { workspace } = useWorkIndex(projectId);
  const versions = useWorkRecords<PlanningItem>(projectId, workspace, 'planningVersions', itemId);
  const ordered = [...versions.records].sort((a, b) => b.version - a.version);
  const latest = ordered[0];
  const [left, setLeft] = useState<number | null>(null);
  const [right, setRight] = useState<number | null>(null);
  const older = ordered.find(entry => entry.version === (left ?? ordered[1]?.version)) ?? null;
  const newer = ordered.find(entry => entry.version === (right ?? latest?.version)) ?? null;
  const a = useResolvedWorkValue(projectId, workspace, 'planningVersions', older);
  const b = useResolvedWorkValue(projectId, workspace, 'planningVersions', newer);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const current = useResolvedWorkValue(projectId, workspace, 'planningVersions', latest ?? null);
  const restore = async () => {
    if (!a || !latest || !current) return;
    setBusy(true);
    setError('');
    try {
      await put({
        itemId,
        expectedVersion: latest.version,
        title: a.title,
        body: a.body,
        reason: `Restored version ${a.version}`,
      });
      announce(`Version ${a.version} restored as a new version.`);
      onOpenChange(false);
    } catch (failure) {
      const changed = failure instanceof Error && /ITEM_CHANGED|changed/i.test(failure.message);
      setError(
        changed
          ? 'Someone changed this Item meanwhile. Nothing was overwritten; compare again with their version.'
          : 'Forge could not restore it; nothing changed.',
      );
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
          {canEdit && a && latest && a.version !== latest.version ? (
            <Key kind="primary" onClick={() => void restore()} disabled={busy || !current}>
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
          <p className="t2">This Item has one version; there is nothing to compare yet.</p>
        ) : (
          <>
            <div className="plan-pair">
              {pick(older?.version ?? null, setLeft, 'Older')}
              {pick(newer?.version ?? null, setRight, 'Newer')}
            </div>
            <p className="t2">Restoring adds a version. It never removes one.</p>
            <pre className="plan-diff" aria-label="Changes between the two versions">
              {diff.map((line, index) => (
                <span key={index} className={line.kind}>
                  {line.kind === 'old' ? '− ' : line.kind === 'new' ? '+ ' : '  '}
                  {line.text}
                  {'\n'}
                </span>
              ))}
            </pre>
            {versions.loading ? <p className="t3">Reading older versions…</p> : null}
          </>
        )}
        {error ? (
          <p className="pf" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
