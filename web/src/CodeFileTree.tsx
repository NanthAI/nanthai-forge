// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, type ReactNode } from 'react';
import { Glyph } from './ui/Glyph';
import { touchTitle, type Touch } from './code-file-model';

type Props = {
  paths: readonly string[];
  selected: string;
  /** Files (and `dir/` folders) an open Lane touches; a plain set shows one neutral dot. */
  touched: ReadonlySet<string> | ReadonlyMap<string, Touch>;
  select: (path: string) => void;
  query?: string;
};
function Dot({ touch }: { touch: Touch | boolean | undefined }) {
  if (!touch) return null;
  const title = touch === true ? 'Touched by an open Lane' : touchTitle(touch);
  return (
    <span
      className={`code-touched touch-${touch === true ? 'active' : touch.tone}`}
      title={title}
      aria-label={title}
    />
  );
}
const depth = (path: string) => ({ ['--depth' as string]: path.split('/').length - 1 });
function Folder({
  path,
  selected,
  touch,
  children,
}: {
  path: string;
  selected: string;
  touch: Touch | boolean | undefined;
  children: ReactNode;
}) {
  // Collapsed except the path to the selected file.
  const [open, setOpen] = useState(selected.startsWith(path));
  useEffect(() => {
    if (selected.startsWith(path)) setOpen(true);
  }, [path, selected]);
  return (
    <details className="code-folder" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary style={{ ['--depth' as string]: path.split('/').length - 2 }}>
        <Glyph name="folder" size={13} />
        <span>{path.split('/').filter(Boolean).at(-1)}</span>
        <Dot touch={touch} />
      </summary>
      {open && <div>{children}</div>}
    </details>
  );
}
export function CodeFileTree({ paths, selected, touched, select, query = '' }: Props) {
  const touchOf = (path: string) => (touched instanceof Map ? touched.get(path) : touched.has(path));
  const fileRow = (path: string, full = false) => (
    <button
      className={`file-row ${selected === path ? 'selected' : ''} ${full ? 'flat' : ''}`}
      style={full ? undefined : depth(path)}
      aria-current={selected === path ? 'page' : undefined}
      key={path}
      title={path}
      onClick={() => select(path)}
    >
      <Glyph name="file" size={13} />
      <span>{full ? path : path.split('/').at(-1)}</span>
      <Dot touch={touchOf(path)} />
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
    ].sort();
    return (
      <>
        {folders.map(folder => (
          <Folder
            key={folder}
            path={folder}
            selected={selected}
            touch={touched instanceof Map ? touched.get(folder) : undefined}
          >
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

/** `728 files · 14 folders` */
export function treeCounts(paths: readonly string[]): string {
  const folders = new Set(
    paths.flatMap(path =>
      path
        .split('/')
        .slice(0, -1)
        .map((_, i, parts) => parts.slice(0, i + 1).join('/')),
    ),
  );
  const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
  return `${plural(paths.length, 'file')} · ${plural(folders.size, 'folder')}`;
}
