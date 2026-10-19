// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, type ReactNode } from 'react';
import { Glyph } from './ui/Glyph';

type Props = {
  paths: readonly string[];
  selected: string;
  touched: ReadonlySet<string>;
  select: (path: string) => void;
  query?: string;
};
function Folder({ path, selected, children }: { path: string; selected: string; children: ReactNode }) {
  const [open, setOpen] = useState(selected.startsWith(path));
  useEffect(() => {
    if (selected.startsWith(path)) setOpen(true);
  }, [path, selected]);
  return (
    <details className="code-folder" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>
        <Glyph name="folder" size={13} />
        {path.split('/').filter(Boolean).at(-1)}
      </summary>
      <div>{children}</div>
    </details>
  );
}
export function CodeFileTree({ paths, selected, touched, select, query = '' }: Props) {
  const fileRow = (path: string, full = false) => (
    <button
      className={`file-row ${selected === path ? 'selected' : ''}`}
      aria-current={selected === path ? 'page' : undefined}
      key={path}
      title={path}
      onClick={() => select(path)}
    >
      <Glyph name="file" size={13} />
      <span>{full ? path : path.split('/').at(-1)}</span>
      {touched.has(path) && (
        <span className="code-touched" title="Touched by an open Lane" aria-label="Touched by an open Lane" />
      )}
    </button>
  );
  const tree = (prefix: string): ReactNode => {
    const children = paths.filter(path => path.startsWith(prefix));
    const folders = [
      ...new Set(
        children.flatMap(path => {
          const tail = path.slice(prefix.length);
          return tail.includes('/') ? [prefix + tail.split('/')[0] + '/'] : [];
        }),
      ),
    ];
    return (
      <>
        {folders.map(folder => (
          <Folder key={folder} path={folder} selected={selected}>
            {tree(folder)}
          </Folder>
        ))}
        {children.filter(path => !path.slice(prefix.length).includes('/')).map(path => fileRow(path))}
      </>
    );
  };
  const matches = paths.filter(path => path.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="code-file-tree">
      {query ? (
        matches.length ? (
          matches.map(path => fileRow(path, true))
        ) : (
          <p className="code-loading">No matching files.</p>
        )
      ) : (
        tree('')
      )}
    </div>
  );
}
