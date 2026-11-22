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
  // The folder text as typed, so separators survive between keystrokes; the parsed list is the value.
  const typed = useRef<string | undefined>(undefined);
  if (!value.paths) typed.current = undefined;
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
        source => {
          const { paths, ...rest } = value;
          change({ ...rest, source, ...(source === 'write' && paths ? { paths } : {}) });
        },
      )}
      <div className="row access-ask">
        <span className="k">Without a check</span>
        <div className="v">
          <b>Never</b>
          <span className="sub">A device cannot grant more access than its person.</span>
        </div>
      </div>
      {value.source === 'write' && value.projects.kind === 'project' ? (
        <>
          {choices(
            'Writes',
            value.paths ? 'folders' : 'project',
            [
              { value: 'project' as const, text: 'Anywhere in the project' },
              { value: 'folders' as const, text: 'Only some folders' },
            ],
            kind => {
              const { paths: _paths, ...rest } = value;
              change(kind === 'folders' ? { ...rest, paths: _paths ?? [] } : rest);
            },
          )}
          {value.paths ? (
            <div className="row access-ask">
              <span className="k">Folders</span>
              <div className="v">
                {readOnly ? (
                  <b className="mono">{value.paths.join(', ')}</b>
                ) : (
                  <input
                    className="inp mono"
                    name="grant-paths"
                    aria-label="Folders agents may write"
                    placeholder="web/, docs/guide.md"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={disabled}
                    value={typed.current ?? value.paths.join(', ')}
                    onChange={event => {
                      typed.current = event.target.value;
                      change({ ...value, paths: grantPaths(event.target.value) });
                    }}
                  />
                )}
                <span className="sub">
                  Ends after 7 days without a write, and 30 days after you give it. Approving or saving gives
                  it again.
                </span>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
      {choices(
        'Projects',
        value.projects.kind,
        [
          ...(project.current
            ? [{ value: 'project' as const, text: `${projectName ?? 'Approved project'} only` }]
            : []),
          { value: 'all' as const, text: 'Every project you can reach' },
        ],
        kind => {
          // A folder grant names folders of one project, so every-project access has none.
          const { paths, ...rest } = value;
          change({
            ...(kind === 'all' ? rest : { ...rest, ...(paths ? { paths } : {}) }),
            projects: kind === 'all' ? { kind: 'all' } : (project.current ?? value.projects),
          });
        },
      )}
    </>
  );
}

/** Comma- or space-separated folders and files as typed; the server checks and refuses unsafe ones. */
export const grantPaths = (text: string) =>
  text
    .split(/[\s,]+/)
    .map(path => path.trim())
    .filter(Boolean);
