// SPDX-License-Identifier: Apache-2.0
// One file's changed hunks, drawn unified or side by side, with syntax colours from the highlight worker (Item
// 8e847a17). The Lane page and a landing's changes (app/code/Changes.tsx) share it, so a diff reads the same
// wherever it opens. Each side is coloured once as one text; a line that cannot be coloured stays plain.
import { useEffect, useState } from 'react';
import { Tokens } from './code-tokens';
import { CodeBox, Segment } from './ds';
import { requestHighlight } from './highlight-client';
import type { SourceToken } from './source-highlight';
import type { Hunk } from './app/lane/file-diff';
import { splitRows, type Cell } from './diff-split';

export type DiffMode = 'unified' | 'split';
const KEY = 'forge.diff-mode';

/** The reader's last choice, kept in this browser only; the page works without it. */
export function useDiffMode(): [DiffMode, (mode: DiffMode) => void] {
  const [mode, set] = useState<DiffMode>(() => {
    try {
      return localStorage.getItem(KEY) === 'split' ? 'split' : 'unified';
    } catch {
      return 'unified';
    }
  });
  return [
    mode,
    next => {
      set(next);
      try {
        localStorage.setItem(KEY, next);
      } catch {
        /* a private window keeps the choice for this visit only */
      }
    },
  ];
}

export function DiffModeToggle({ mode, onChange }: { mode: DiffMode; onChange: (mode: DiffMode) => void }) {
  return (
    <Segment
      label="Diff layout"
      value={mode}
      onChange={onChange}
      options={[
        { value: 'unified', text: 'Unified' },
        { value: 'split', text: 'Split' },
      ]}
    />
  );
}

/** Colour each side once per opened file: the after side's lines, then the before side's, each as one text. */
function useTokens(path: string, hunks: Hunk[]) {
  const [tokens, setTokens] = useState<Map<string, SourceToken[]> | null>(null);
  useEffect(() => {
    let live = true;
    const sides = { after: [] as string[], before: [] as string[] };
    const keys = { after: [] as string[], before: [] as string[] };
    hunks.forEach((hunk, h) =>
      hunk.lines.forEach((line, l) => {
        if (line.escaped) return;
        const side = line.kind === 'removed' ? 'before' : 'after';
        sides[side].push(line.text);
        keys[side].push(`${h}:${l}`);
      }),
    );
    void Promise.all([
      requestHighlight(path, sides.after.join('\n')),
      sides.before.length ? requestHighlight(path, sides.before.join('\n')) : Promise.resolve([]),
    ]).then(([after, before]) => {
      if (!live) return;
      const map = new Map<string, SourceToken[]>();
      keys.after.forEach((key, i) => after[i] && map.set(key, after[i]!));
      keys.before.forEach((key, i) => before[i] && map.set(key, before[i]!));
      setTokens(map);
    });
    return () => {
      live = false;
    };
  }, [path, hunks]);
  return tokens;
}

export function DiffView({
  path,
  hunks,
  mode,
  onColoured,
}: {
  path: string;
  hunks: Hunk[];
  mode: DiffMode;
  /** Called once the colours are in (the QA first-diff marker). */
  onColoured?: (coloured: boolean) => void;
}) {
  const tokens = useTokens(path, hunks);
  useEffect(() => onColoured?.(tokens !== null), [tokens, onColoured]);
  const cell = (side: Cell, which: 'l' | 'r') =>
    side ? (
      <>
        <span className={`n ${side.kind}`}>{side.n}</span>
        <span className={`c ${side.kind}`} data-side={which}>
          <Tokens tokens={tokens?.get(side.key)} text={side.text} />
        </span>
      </>
    ) : (
      <>
        <span className="n gap" />
        <span className="c gap" />
      </>
    );
  if (mode === 'split')
    return (
      <div className="code split" role="region" aria-label={`Changes to ${path}, side by side`} tabIndex={0}>
        {hunks.map((hunk, h) => (
          <div key={h}>
            <div className="l hunk">
              <span className="c">line {hunk.afterStart.toLocaleString()}</span>
            </div>
            {splitRows(hunk, h).map((row, i) => (
              <div key={i} className="l">
                {cell(row.left, 'l')}
                {cell(row.right, 'r')}
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  return (
    <CodeBox label={`Changes to ${path}`}>
      {hunks.map((hunk, h) => {
        let before = hunk.beforeStart,
          after = hunk.afterStart;
        return (
          <div key={h}>
            <div className="l hunk">
              <span className="n" />
              <span className="n" />
              <span className="c">line {hunk.afterStart.toLocaleString()}</span>
            </div>
            {hunk.lines.map((line, l) => {
              const b = line.kind === 'added' ? '' : before++;
              const a = line.kind === 'removed' ? '' : after++;
              return (
                <div
                  key={l}
                  className={`l${line.kind === 'added' ? ' add' : line.kind === 'removed' ? ' del' : ''}`}
                >
                  <span className="n">{b}</span>
                  <span className="n">{a}</span>
                  <span className="c">
                    <Tokens tokens={tokens?.get(`${h}:${l}`)} text={line.text} />
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}
    </CodeBox>
  );
}
