// SPDX-License-Identifier: Apache-2.0
// Where Lanes cross, drawn by pair (Item df1f2d46; design signed off on the Item): the pairs of Items that saved the
// same files, a conflict Forge observed first (never a shared file alone), then most shared files, each with its
// count over an amount stick. A pair opens in place to its Lanes and its files by folder. An Item's own Lanes crossing
// each other are one quiet line under the pairs, not a pair. Every fold and "show more" is local: nothing here reads
// or stores anything. A pair's files are listed only for the rows drawn, and a "show more" moves focus to the first
// thing it revealed.
import { useEffect, useMemo, useState } from 'react';
import { Band, State } from '../../ds';
import { A } from '../frames';
import { byFolder, pairPaths, type CrossPair, type CrossSide, type Folder } from './cross-pairs';
import type { SharedFile } from './model';

const FIRST_PAIRS = 6;
const MORE_PAIRS = 25;
const FIRST_FOLDERS = 3;
const FIRST_NAMES = 12;

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const lanesWord = (n: number) => plural(n, 'Lane', 'Lanes');
const dirLabel = (dir: string) => dir || 'top level';

type Links = { laneHref: (laneId: string) => string; conflicted: (laneId: string) => boolean };
const idOf = (pair: CrossPair) => `cx-${pair.key.replace(/[^\w-]/g, '_')}`;

/** Focus the element with this id after the render that drew it: a "show more" key leaves, so its reader lands on the
 * first thing it revealed instead of the page's start. */
function useFocusNext(): (id: string) => void {
  const [next, setNext] = useState<string | null>(null);
  useEffect(() => {
    if (next) document.getElementById(next)?.focus();
  }, [next]);
  return setNext;
}

export function CrossList({
  pairs,
  own,
  shared,
  ...links
}: { pairs: CrossPair[]; own: CrossPair[]; shared: readonly SharedFile[] } & Links) {
  const [shown, setShown] = useState(FIRST_PAIRS);
  const focusNext = useFocusNext();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setOpen(was => {
      const next = new Set(was);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const widest = Math.max(1, ...pairs.map(pair => pair.files));
  const atRisk = pairs.filter(pair => pair.conflicted.length);
  const rest = pairs.filter(pair => !pair.conflicted.length);
  const visible = new Set(pairs.slice(0, shown).map(pair => pair.key));
  const band = (title: string, list: CrossPair[], hint: string) =>
    list.some(pair => visible.has(pair.key)) ? (
      <>
        <Band title={title} count={list.length} hint={hint} />
        {list
          .filter(pair => visible.has(pair.key))
          .map(pair => (
            <PairRow
              key={pair.key}
              pair={pair}
              shared={shared}
              widest={widest}
              open={open.has(pair.key)}
              onToggle={() => toggle(pair.key)}
              {...links}
            />
          ))}
      </>
    ) : null;
  const left = pairs.length - shown;
  return (
    <>
      {band('Conflict reported', atRisk, 'Forge found these Lanes conflict, when one was saved or landing')}
      {band('Same files', rest, 'most shared files first')}
      {left > 0 ? (
        <div className="pf">
          Showing {shown.toLocaleString()} of {plural(pairs.length, 'pair', 'pairs')}.{' '}
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              setShown(shown + MORE_PAIRS);
              focusNext(`${idOf(pairs[shown]!)}-key`);
            }}
          >
            Show {Math.min(left, MORE_PAIRS).toLocaleString()} more {left === 1 ? 'pair' : 'pairs'}
          </button>
        </div>
      ) : null}
      {own.map(pair => (
        <p key={pair.key} className="quietline cx-own">
          <span className="cx-title" dir="auto">
            {pair.a.title}
          </span>{' '}
          has {pair.aLanes.length.toLocaleString()} open {pair.aLanes.length === 1 ? 'Lane' : 'Lanes'} sharing{' '}
          {plural(pair.files, 'file', 'files')}: <LaneMarks lanes={pair.aLanes} {...links} />. Set aside the
          ones it no longer needs.
        </p>
      ))}
    </>
  );
}

function Side({ side, lanes, lead }: { side: CrossSide; lanes: number; lead?: boolean }) {
  return (
    <span className="cx-name">
      <span className="cx-t">
        {lead ? null : <span className="cx-and">and </span>}
        <span dir="auto">{side.title}</span>
      </span>
      <span className="cx-n">{lanesWord(lanes)}</span>
    </span>
  );
}

function LaneMarks({ lanes, laneHref, conflicted }: { lanes: string[] } & Links) {
  return (
    <>
      {lanes.map((laneId, index) => (
        <span key={laneId}>
          {index ? (index === lanes.length - 1 ? ' and ' : ', ') : ''}
          <A className="lk mono" href={laneHref(laneId)} translate="no">
            {laneId.slice(0, 8)}
          </A>
          {conflicted(laneId) ? (
            <>
              {' '}
              <State word="Conflict" />
            </>
          ) : null}
        </span>
      ))}
    </>
  );
}

function PairRow({
  pair,
  shared,
  widest,
  open,
  onToggle,
  ...links
}: {
  pair: CrossPair;
  shared: readonly SharedFile[];
  widest: number;
  open: boolean;
  onToggle: () => void;
} & Links) {
  const folders = useMemo(() => byFolder(pairPaths(shared, pair)), [shared, pair]);
  const id = idOf(pair);
  const top = folders.slice(0, FIRST_FOLDERS);
  const files = pair.files;
  return (
    <>
      <button
        type="button"
        id={`${id}-key`}
        className="cx-pair"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
      >
        <span className="cx-turn" aria-hidden="true" />
        <span className="cx-names">
          <Side side={pair.a} lanes={pair.aLanes.length} lead />
          {pair.b ? <Side side={pair.b} lanes={pair.bLanes.length} /> : null}
          <span className="cx-meta">
            {pair.conflicted.length ? <State word="Conflict" /> : null}
            <span translate="no">
              {top
                .map(folder => `${dirLabel(folder.dir)} ${folder.names.length.toLocaleString()}`)
                .join(' · ')}
              {folders.length > top.length
                ? ` · ${plural(folders.length - top.length, 'more folder', 'more folders')}`
                : ''}
            </span>
          </span>
        </span>
        <span className="cx-weight">
          <b>{plural(files, 'file', 'files')}</b>
          <span className="stick" aria-hidden="true">
            <i style={{ ['--v' as string]: Math.max(1, (files / widest) * 100) }} />
          </span>
        </span>
      </button>
      <div id={id} className="cx-open" hidden={!open}>
        {open ? (
          <>
            <div className="cx-lanes">
              Lanes: <LaneMarks lanes={[...pair.aLanes, ...pair.bLanes]} {...links} />
            </div>
            <Folders id={id} folders={folders} files={files} />
          </>
        ) : null}
      </div>
    </>
  );
}

function Folders({ id, folders, files }: { id: string; folders: Folder[]; files: number }) {
  const focusNext = useFocusNext();
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(folders[0] ? [folders[0].dir] : []));
  const [full, setFull] = useState<ReadonlySet<string>>(new Set());
  const shown = all ? folders : folders.slice(0, FIRST_FOLDERS);
  const hidden = folders.length - shown.length;
  return (
    <>
      {shown.map((folder, at) => {
        const isOpen = open.has(folder.dir);
        // Names are sorted only for a folder that is open.
        const sorted = isOpen
          ? [...folder.names].sort((x, y) => x.localeCompare(y, undefined, { numeric: true }))
          : [];
        const names = full.has(folder.dir) ? sorted : sorted.slice(0, FIRST_NAMES);
        const other = sorted.length - names.length;
        return (
          <div key={folder.dir}>
            <button
              type="button"
              id={`${id}-d${at}`}
              className="cx-dir"
              aria-expanded={isOpen}
              onClick={() =>
                setOpen(was => {
                  const next = new Set(was);
                  if (!next.delete(folder.dir)) next.add(folder.dir);
                  return next;
                })
              }
            >
              <span className="cx-turn" aria-hidden="true" />
              <span className={folder.dir ? 'cx-path' : 'cx-path cx-top'} translate="no">
                <bdi dir="ltr">{dirLabel(folder.dir)}</bdi>
              </span>
              <span className="cx-c">{folder.names.length.toLocaleString()}</span>
              <span className="stick" aria-hidden="true">
                <i style={{ ['--v' as string]: Math.max(1, (folder.names.length / files) * 100) }} />
              </span>
            </button>
            {isOpen ? (
              <ul className="cx-files">
                {names.map((name, n) => (
                  <li key={name} id={`${id}-d${at}-f${n}`} tabIndex={-1} translate="no" dir="ltr">
                    {name}
                  </li>
                ))}
                {other > 0 ? (
                  <li className="cx-more">
                    <button
                      type="button"
                      className="btn sm ghost"
                      onClick={() => {
                        setFull(was => new Set(was).add(folder.dir));
                        focusNext(`${id}-d${at}-f${FIRST_NAMES}`);
                      }}
                    >
                      Show the other {plural(other, 'file', 'files')}
                    </button>
                  </li>
                ) : null}
              </ul>
            ) : null}
          </div>
        );
      })}
      {hidden > 0 ? (
        <button
          type="button"
          className="btn sm ghost cx-folders"
          onClick={() => {
            setAll(true);
            focusNext(`${id}-d${FIRST_FOLDERS}`);
          }}
        >
          Show {plural(hidden, 'more folder', 'more folders')}
        </button>
      ) : null}
    </>
  );
}
