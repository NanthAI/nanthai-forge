import { ErrorToast } from '../ui/Toast';
import { useDestination, useSection } from '../WorkspaceUI';
// SPDX-License-Identifier: Apache-2.0
import { Profiler, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChangeMapToggle, type MapSource } from './ChangeMapToggle';
import { PathLabel } from './PathLabel';
import { Glyph } from '../ui/Glyph';
import { Callout, Panel } from '../ui/primitives';
import { profileDiff } from './diff-profile';
import { Diff, DiffModes, type Comparison } from './Diff';
import { useLanePreference } from './preferences';

export type ChangedPath = { path: string; status: string; add?: number; del?: number; approximate: boolean };

/** Changed files beside the selected file's line diff. Overlapping files carry a note above their diff. */
export function ChangesPanel({
  title = 'Changes',
  paths,
  loading,
  error,
  subtitle,
  overlaps,
  load,
  footer,
  onSettled,
  compactFiles = false,
  mapSource,
  loadNeighbour,
  comment,
}: {
  title?: string;
  paths: readonly ChangedPath[] | null;
  loading?: boolean;
  error?: string;
  subtitle?: ReactNode;
  overlaps?: ReadonlyMap<string, string[]>;
  load: (path: string, signal: AbortSignal) => Promise<Comparison>;
  footer?: ReactNode;
  onSettled?: () => void;
  compactFiles?: boolean;
  mapSource?: MapSource;
  loadNeighbour?: typeof load;
  comment?: (file: string, side: 'before' | 'after', line: number, blob: string) => void;
}) {
  const cache = useRef<{ load: typeof load; files: Map<string, Comparison> }>({ load, files: new Map() });
  const [selected, setSelected] = useDestination('diffFile');
  const [neighbour, setNeighbour] = useState<ChangedPath>();
  const [allFiles, showAllFiles] = useState(false);
  const [viewed, setViewed] = useState<ReadonlySet<string>>(new Set());
  const [files, setFiles] = useLanePreference('forge.lane.files', ['open', 'closed'], 'open');
  const [preferredMode, rememberMode] = useLanePreference(
    'forge.diff.mode',
    ['unified', 'split', 'inline'],
    'unified',
  );
  const [mode, chooseMode] = useSection('diffMode', ['unified', 'split', 'inline'] as const, preferredMode);
  const setMode = (next: typeof mode) => {
    rememberMode(next);
    chooseMode(next);
  };
  const [retry, setRetry] = useState(0);
  const [diff, setDiff] = useState<{ path: string; comparison?: Comparison; error?: string } | null>(null);
  const current =
    paths?.find(item => item.path === selected) ?? (neighbour?.path === selected ? neighbour : paths?.[0]);
  const currentPath = current?.path;
  useEffect(() => {
    if (!currentPath) return;
    const controller = new AbortController();
    if (cache.current.load !== load) cache.current = { load, files: new Map() };
    const files = cache.current.files;
    const hit = files.get(currentPath);
    if (hit) {
      setDiff({ path: currentPath, comparison: hit });
      onSettled?.();
      return;
    }
    setDiff({ path: currentPath });
    (current?.status === 'unchanged' && loadNeighbour ? loadNeighbour : load)(currentPath, controller.signal)
      .then(comparison => {
        if (!controller.signal.aborted) {
          files.set(currentPath, comparison);
          setDiff({ path: currentPath, comparison });
          onSettled?.();
        }
      })
      .catch(e => {
        if (!controller.signal.aborted) {
          setDiff({ path: currentPath, error: (e as Error).message });
          onSettled?.();
        }
      });
    return () => controller.abort();
  }, [currentPath, load, loadNeighbour, current?.status, onSettled, retry]);
  return (
    <Panel
      title={title}
      count={paths ? `${paths.length} ${paths.length === 1 ? 'file' : 'files'}` : undefined}
      actions={
        <>
          {subtitle && <span className="fx-faint">{subtitle}</span>}
          {paths?.length && files === 'open' ? (
            <button
              type="button"
              className="fx-collapse"
              aria-label="Hide file list"
              title="Hide file list (remembered)"
              onClick={() => setFiles('closed')}
            >
              <Glyph name="back" size={12} />
            </button>
          ) : null}
        </>
      }
      footer={footer}
    >
      {error ? (
        <ErrorToast read>{error}</ErrorToast>
      ) : loading || !paths ? (
        <p className="fx-loading" role="status">
          Reading changes…
        </p>
      ) : paths.length === 0 ? (
        <p className="fx-panel-note">No saved changes yet.</p>
      ) : (
        <div className="fx-changes" data-files={files}>
          <button
            type="button"
            className="fx-rail-files"
            aria-label="Show file list"
            onClick={() => setFiles('open')}
          >
            <Glyph name="arrow" size={12} />
            <span>Files</span>
            <b className="fx-count">{paths.length}</b>
          </button>
          <ChangeMapToggleOrFiles
            source={mapSource}
            selected={currentPath ?? ''}
            select={(path, node) => {
              setSelected(path);
              setNeighbour({
                path,
                status: node.status,
                add: node.add,
                del: node.del,
                approximate: node.approximate,
              });
            }}
          >
            <div className="fx-files-wrap">
              <ul className="fx-files" aria-label="Changed files">
                {(compactFiles && !allFiles ? paths.slice(0, 5) : paths).map(item => (
                  <li key={item.path}>
                    <button
                      type="button"
                      aria-current={item.path === current?.path ? 'true' : undefined}
                      onClick={() => setSelected(item.path)}
                      title={item.path}
                      aria-label={item.path}
                    >
                      <span
                        title={
                          overlaps?.has(item.path)
                            ? `Also changed by ${overlaps.get(item.path)!.join(', ')}`
                            : undefined
                        }
                      >
                        <Glyph name={overlaps?.has(item.path) ? 'overlap' : 'file'} size={13} />
                      </span>
                      <PathLabel path={item.path} />
                      <span className="fx-diffstat">
                        {item.add !== undefined && <span className="fx-add">+{item.add}</span>}{' '}
                        {item.del !== undefined && <span className="fx-del">−{item.del}</span>}
                      </span>
                    </button>
                  </li>
                ))}
                {compactFiles && paths.length > 5 && (
                  <li>
                    <button className="fx-files-more" type="button" onClick={() => showAllFiles(!allFiles)}>
                      {allFiles ? 'Show fewer files' : `+${paths.length - 5} more`}
                    </button>
                  </li>
                )}
              </ul>
            </div>
          </ChangeMapToggleOrFiles>
          <div className="fx-file-view">
            {current && (
              <>
                <div className="fx-file-head">
                  <code>{current.path}</code>
                  <span className="fx-diffstat">
                    {current.add !== undefined && <span className="fx-add">+{current.add}</span>}{' '}
                    {current.del !== undefined && <span className="fx-del">−{current.del}</span>}
                  </span>
                  <label className="fx-viewed">
                    <input
                      type="checkbox"
                      checked={viewed.has(current.path)}
                      onChange={event =>
                        setViewed(previous => {
                          const next = new Set(previous);
                          if (event.target.checked) next.add(current.path);
                          else next.delete(current.path);
                          return next;
                        })
                      }
                    />
                    Viewed
                  </label>
                  <DiffModes mode={mode} onChange={setMode} />
                </div>
                {overlaps?.has(current.path) && (
                  <div className="fx-file-note">
                    <Callout tone="waiting">
                      <b>{overlaps.get(current.path)!.join(', ')}</b> also{' '}
                      {overlaps.get(current.path)!.length > 1 ? 'change' : 'changes'} this file.
                    </Callout>
                  </div>
                )}
                {diff?.path === current.path && diff.error ? (
                  <ErrorToast read>
                    {diff.error} <button onClick={() => setRetry(value => value + 1)}>Retry</button>
                  </ErrorToast>
                ) : diff?.comparison && diff.path === current.path ? (
                  <Profiler id="local-diff" onRender={profileDiff}>
                    <Diff
                      {...(comment
                        ? {
                            comment: (side, line) =>
                              comment(
                                currentPath!,
                                side,
                                line,
                                (side === 'before'
                                  ? diff.comparison?.beforeBlob
                                  : diff.comparison?.afterBlob) ?? '',
                              ),
                          }
                        : {})}
                      comparison={diff.comparison}
                      status={current.status}
                      file={current.path}
                      mode={mode}
                    />
                  </Profiler>
                ) : (
                  <p className="fx-loading" role="status">
                    Reading {current.path}…
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}

function ChangeMapToggleOrFiles({
  source,
  children,
  ...props
}: Omit<Parameters<typeof ChangeMapToggle>[0], 'source'> & { source?: MapSource }) {
  return source ? (
    <div className="fx-map-browser">
      <ChangeMapToggle source={source} {...props}>
        {children}
      </ChangeMapToggle>
    </div>
  ) : (
    <>{children}</>
  );
}
