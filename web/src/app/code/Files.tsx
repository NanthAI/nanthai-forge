// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Files: the tree, the file and what touched it, at main or at one exact State (`?at=`). One fixed frame (DESIGN.md
// rule 3): the tree drives the file, the file drives the context. Each region loads and fails on its own.
import { useState } from 'react';
import { Head, crumbsFor } from '../Place';
import { A } from '../frames';
import { hrefFor } from '../paths';
import { useSearch } from '../router';
import { RegionBoundary, type CodeProps } from './CodePlace';
import { pinnedState, plural, short } from './code-words';
import { FileBody, useCodeLine } from './FileBody';
import { FileHeading } from './FileHeading';
import { Changing, SavedMark, useChanging } from './Changing';
import { FindFile } from './FindFile';
import { LineHistory } from './LineHistory';
import { useFileHistory } from './use-file-history';
import { useCodeReceipt, useHistory, type CodeDir } from './code-data';
import { useSource, type Source } from './use-source';
import { FileHistory } from './FileHistory';

export function Files(props: CodeProps) {
  const { route, projectId, projectName, mainHead } = props;
  const search = useSearch();
  const pinned = pinnedState(`?${search.toString()}`);
  const state = pinned ?? mainHead ?? null;
  const path = route.rest;
  const source = useSource(projectId, state, path);
  const history = useHistory(projectId, { skip: !pinned });
  const work = useChanging(projectId, !pinned && Boolean(state));
  const selectedLine = useCodeLine();
  const receiptId = pinned ? (search.get('receipt') ?? '') : '';
  const listed =
    pinned && history.rows.find(row => row.head === pinned && (!receiptId || row.receiptId === receiptId));
  const exact = useCodeReceipt(projectId, listed || history.loading ? '' : receiptId, 0);
  const landing = listed || exact.value?.landings.find(row => row.head === pinned) || null;
  const where = !pinned
    ? 'at main'
    : landing
      ? `as “${landing.title ?? short(landing.head)}” left it`
      : `at State ${short(pinned)}`;
  const href = (to: string) =>
    `${hrefFor({ ...route, rest: to })}${pinned ? `?at=${pinned}${receiptId ? `&receipt=${encodeURIComponent(receiptId)}` : ''}` : ''}`;
  const file = source.file?.state === state && source.file.path === path ? source.file : null;
  const lines = file?.pages.length
    ? file.pages
        .map(p => p.text)
        .join('')
        .replace(/\n$/, '')
        .split('\n').length
    : null;
  const done = file?.pages.at(-1)?.nextOffset === null;
  const sentence =
    mainHead === null && !pinned ? (
      'This project has no main yet. Its files appear here after the first landing.'
    ) : source.unavailable ? (
      source.unavailable
    ) : source.kind === 'missing' ? (
      <>
        <b>Nothing at this path</b> {where}. It may have moved or been removed.
      </>
    ) : source.kind === 'file' && lines !== null ? (
      <>
        <b>
          {done ? '' : 'At least '}
          {plural(lines, 'line')}
        </b>{' '}
        {where}.
      </>
    ) : source.files !== null ? (
      <>
        <b>{plural(source.files, 'file')}</b> {where}.
      </>
    ) : (
      `The files ${where}.`
    );
  const command = `nforge agent . show '${JSON.stringify(pinned ? { state: pinned, path: path || 'README.md' } : { channel: 'main', path: path || 'README.md' })}'`;
  const [cli, setCli] = useState(false);
  const isFile = source.kind === 'file';
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const knownFile =
    source.file?.path === path ||
    source.dirs.get(parent)?.entries.some(entry => entry.path === path && entry.kind !== 'dir');
  const before = landing ? landing.sequence + 1 : null;
  const touched = Boolean(state && knownFile && (!pinned || (!history.loading && !exact.loading)));
  const fileHistory = useFileHistory(projectId, touched ? path : null, before, state);
  const head = file?.head ?? null;
  return (
    <>
      <Head trail={crumbsFor(route, projectName)} sentence={sentence}>
        {pinned ? (
          <A className="btn sm" href={hrefFor(route)}>
            Back to main
          </A>
        ) : null}
        <button
          type="button"
          className="cli mono"
          aria-expanded={cli}
          aria-controls="code-cli"
          onClick={() => setCli(open => !open)}
          title="What an agent runs to read this"
        >
          <span>nforge agent . show</span>
        </button>
      </Head>
      {cli ? (
        <pre className="cli-out mono" id="code-cli">
          <b>$ {command}</b>
          {'\n'}Prints the file's exact bytes.
        </pre>
      ) : null}
      <div className="panes code-f">
        <section className={`pane tree${isFile ? ' off' : ''}`} aria-label="Files">
          <div className="ph plain">
            <h2>{pinned ? (landing ? 'At a landing' : `State ${short(pinned)}`) : 'main'}</h2>
            {source.files !== null ? <span className="hint">{plural(source.files, 'file')}</span> : null}
          </div>
          <div className="body">
            <RegionBoundary label="The files">
              <FindFile projectId={projectId} state={state} href={href}>
                <Tree source={source} href={href} path={path} saved={work.paths} />
              </FindFile>
            </RegionBoundary>
          </div>
        </section>
        <section className={`pane${isFile ? '' : ' off'}`} aria-label="File">
          <div className="ph plain">
            <FileHeading path={path} isFile={isFile} head={head} lines={lines} done={done} where={where} />
            {isFile ? (
              <A
                className="lk hide-dt"
                href={href(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')}
              >
                Up to the folder
              </A>
            ) : null}
          </div>
          <div className="body">
            {source.error ? (
              <div className="pad" role="alert">
                <p>{source.error}</p>
                <button type="button" className="btn sm" onClick={source.retry}>
                  Retry
                </button>
              </div>
            ) : source.file ? (
              <FileBody
                key={`${source.file.state}:${source.file.path}`}
                file={source.file}
                onMore={source.morePage}
                line={selectedLine}
                repo={{ projectId, state: source.file.state, href }}
              />
            ) : source.loading ? (
              <p className="pad t3" aria-busy="true">
                Reading…
              </p>
            ) : (
              <p className="pad t2">Choose a file in the tree to read it here.</p>
            )}
          </div>
        </section>
        <section className={`pane quiet${isFile ? '' : ' off'}`} aria-label="In this file" data-weight="ref">
          <div className="body">
            {isFile ? <Changing work={work} path={path} route={route} /> : null}
            {state &&
            head?.available &&
            head.blob &&
            head.page?.kind === 'text' &&
            (head.mode === 'file' || head.mode === 'executable') &&
            (work.value || (pinned && fileHistory.traceable !== undefined)) ? (
              <LineHistory
                key={JSON.stringify([projectId, state, path])}
                projectId={projectId}
                path={path}
                route={route}
                blob={head.blob}
                state={state}
                line={selectedLine}
                file={fileHistory}
              />
            ) : null}
            <div className="ph plain">
              <h2>Landings that touched it</h2>
            </div>
            {touched ? <FileHistory file={fileHistory} path={path} route={route} /> : null}
            {landing || !touched ? (
              <div className="pf">
                <A
                  className="lk"
                  href={hrefFor({
                    ...route,
                    section: landing ? '' : 'history',
                    rest: landing?.receiptId ?? '',
                  })}
                >
                  {landing ? 'This landing’s receipt' : 'Everything that landed'}
                </A>
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </>
  );
}

function Tree({
  source,
  href,
  path,
  saved,
}: {
  source: Source;
  href: (to: string) => string;
  path: string;
  saved: ReturnType<typeof useChanging>['paths'];
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const root = source.dirs.get('');
  if (!root)
    return source.loading ? (
      <p className="pad t3" aria-busy="true">
        Reading the folders…
      </p>
    ) : null;
  const onPath = (dir: string) => path === dir || path.startsWith(`${dir}/`);
  const toggle = (dir: string, expanded: boolean) => {
    if (!expanded) source.openDir(dir);
    setOpen(was => {
      const next = new Set(was);
      // A folder on the open path starts open; "!dir" remembers that the reader shut it.
      next.delete(expanded ? dir : `!${dir}`);
      next.add(expanded ? `!${dir}` : dir);
      return next;
    });
  };
  const draw = (dir: CodeDir, depth: number) => (
    <ul>
      {dir.entries.map(entry => {
        if (entry.kind !== 'dir')
          return (
            <li key={entry.path}>
              <A
                href={href(entry.path)}
                className={entry.path === path ? 'on' : undefined}
                aria-current={entry.path === path ? 'page' : undefined}
                style={{ '--d': depth } as never}
              >
                <span className="tsp" aria-hidden="true" />
                <span className="nm" dir="auto">
                  {entry.name}
                </span>
                <SavedMark lanes={saved.get(entry.path)?.size ?? 0} />
                {entry.kind !== 'file' ? <span className="n">{entry.kind}</span> : null}
              </A>
            </li>
          );
        const expanded = open.has(entry.path) || (onPath(entry.path) && !open.has(`!${entry.path}`));
        const child = source.dirs.get(entry.path);
        return (
          <li key={entry.path}>
            <button
              type="button"
              className="dir"
              aria-expanded={expanded}
              onClick={() => toggle(entry.path, expanded)}
              style={{ '--d': depth } as never}
            >
              <span className="tw" aria-hidden="true" />
              <span className="nm" dir="auto">
                {entry.name}
              </span>
              <SavedMark lanes={saved.get(entry.path)?.size ?? 0} />
              <span className="n">{entry.files?.toLocaleString()}</span>
            </button>
            {expanded ? (
              child ? (
                draw(child, depth + 1)
              ) : (
                <p className="more t3" style={{ '--d': depth + 1 } as never}>
                  Reading…
                </p>
              )
            ) : null}
          </li>
        );
      })}
      {dir.next !== null ? (
        <li className="more" style={{ '--d': depth } as never}>
          <button type="button" className="btn sm ghost" onClick={() => source.openDir(dir.path, dir.next!)}>
            {dir.entries.length.toLocaleString()} of {dir.total.toLocaleString()}; show more
          </button>
        </li>
      ) : null}
    </ul>
  );
  return draw(root, 0);
}
