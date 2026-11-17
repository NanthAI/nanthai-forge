// SPDX-License-Identifier: Apache-2.0
import { useRef } from 'react';
import { Segment } from '../ds';
import type { DeviceSettings as Settings } from './access-contract';
/** One editor for the first approval and the account's device settings. */
export function DeviceSettings({
  value,
  change,
  projectName,
  disabled,
  readOnly,
}: {
  value: Settings;
  change: (value: Settings) => void;
  projectName?: string | null;
  disabled?: boolean;
  readOnly?: boolean;
}) {
  const project = useRef(value.projects.kind === 'project' ? value.projects : null);
  if (value.projects.kind === 'project') project.current = value.projects;
  const choices = <T extends string>(
    label: string,
    current: T,
    options: { value: T; text: string }[],
    select: (value: T) => void,
  ) => (
    <div className="row access-ask">
      <span className="k">{label}</span>
      <div className="v">
        {readOnly ? (
          <b>{options.find(option => option.value === current)?.text}</b>
        ) : (
          <Segment label={label} value={current} options={options} onChange={select} disabled={disabled} />
        )}
      </div>
    </div>
  );
  return (
    <>
      {choices(
        'Agents on it',
        value.source,
        [
          { value: 'write', text: 'May write and land with a check' },
          { value: 'read', text: 'Read only' },
          { value: 'coordination', text: 'Coordination only' },
        ],
        source => change({ ...value, source }),
      )}
      <div className="row access-ask">
        <span className="k">Without a check</span>
        <div className="v">
          <b>Never</b>
          <span className="sub">A device cannot grant more access than its person.</span>
        </div>
      </div>
      {choices(
        'Projects',
        value.projects.kind,
        [
          ...(project.current
            ? [{ value: 'project' as const, text: `${projectName ?? 'Approved project'} only` }]
            : []),
          { value: 'all' as const, text: 'Every project you can reach' },
        ],
        kind =>
          change({
            ...value,
            projects: kind === 'all' ? { kind: 'all' } : (project.current ?? value.projects),
          }),
      )}
    </>
  );
}
