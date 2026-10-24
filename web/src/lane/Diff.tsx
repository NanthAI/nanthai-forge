// SPDX-License-Identifier: Apache-2.0
import { Fragment, memo } from 'react';
import { LazyLines } from './LazyLines';
import { numberedLines, pairedLines, wordChanges, type Line } from './diff-rows';
import { SyntaxLine } from '../SourceTokens';
export type Hunk = {
  beforeStart: number;
  afterStart: number;
  beforeLines: number;
  afterLines: number;
  lines: { kind: 'context' | 'removed' | 'added'; text: string }[];
};
export type Comparison = {
  hunks: Hunk[];
  truncated: boolean;
  content?: string;
  beforeBlob?: string | null;
  afterBlob?: string | null;
  blob?: string;
};
export type DiffMode = 'unified' | 'split' | 'inline';
export function DiffModes({ mode, onChange }: { mode: DiffMode; onChange: (mode: DiffMode) => void }) {
  return (
    <div className="fx-diff-modes" role="group" aria-label="Diff mode">
      {(['unified', 'split', 'inline'] as const).map(value => (
        <button type="button" key={value} aria-pressed={mode === value} onClick={() => onChange(value)}>
          {value === 'inline' ? 'Inline' : value === 'split' ? 'Split' : 'Unified'}
        </button>
      ))}
    </div>
  );
}
/** Same per-file comparison in all modes; selecting a mode never starts another source read. */
export const Diff = memo(function Diff({
  comparison,
  status,
  mode = 'unified',
  file = '',
  comment,
}: {
  comparison: Comparison;
  status?: string;
  mode?: DiffMode;
  file?: string;
  comment?: (side: 'before' | 'after', line: number) => void;
}) {
  const prose = /\.(?:md|mdx|txt|rst)$/i.test(file);
  const whole = status === 'added' || status === 'deleted';
  const plain =
    comparison.truncated ||
    comparison.hunks.reduce(
      (size, hunk) => size + hunk.lines.reduce((sum, line) => sum + line.text.length, 0),
      0,
    ) > 1_000_000;
  if (!comparison.hunks.length)
    return (
      <p className="fx-diff-note">
        {comparison.content ?? (comparison.truncated ? 'Not shown as text.' : 'No line changes (mode only).')}
      </p>
    );
  const number = (side: 'before' | 'after', line: number | '' | undefined) =>
    comment && typeof line === 'number' ? (
      <button
        type="button"
        className="fx-line-comment"
        aria-label={`Comment on ${side} line ${line}`}
        onClick={() => comment(side, line)}
      >
        {line}
      </button>
    ) : (
      line
    );
  const source = (line: Line, hunk: number) => (
    <SyntaxLine
      text={line.text}
      file={file}
      plain={plain}
      blob={
        (line.kind === 'removed' ? comparison.beforeBlob : (comparison.afterBlob ?? comparison.blob)) ??
        undefined
      }
      range={`${hunk}:${line.index}`}
    />
  );
  return (
    <div
      className={`fx-diff diff${mode === 'split' ? ' fx-diff-split' : ''}`}
      aria-label="Line changes"
      data-mode={mode}
      data-prose={prose || undefined}
    >
      {comparison.truncated && comparison.content && <p className="fx-diff-note">{comparison.content}</p>}
      <table aria-label="Line changes">
        <colgroup>
          {mode === 'split' ? (
            <>
              <col style={{ width: 38 }} />
              <col />
              <col style={{ width: 1 }} />
              <col style={{ width: 38 }} />
              <col />
            </>
          ) : (
            <>
              <col style={{ width: 38 }} />
              <col style={{ width: 38 }} />
              <col />
            </>
          )}
        </colgroup>
        {comparison.hunks.map((hunk, index) => {
          const lines = numberedLines(hunk, whole && index === comparison.hunks.length - 1);
          const rows =
            mode === 'unified'
              ? lines.map(line => ({
                  left: line.kind !== 'added' ? line : undefined,
                  right: line.kind !== 'removed' ? line : undefined,
                }))
              : pairedLines(lines);
          return (
            <Fragment key={index}>
              <tbody>
                <tr className="fx-diff-hunk" key={`h${index}`}>
                  <td colSpan={mode === 'split' ? 5 : 3}>
                    @@ −{hunk.beforeStart},{hunk.beforeLines} +{hunk.afterStart},{hunk.afterLines} @@
                  </td>
                </tr>
              </tbody>
              <LazyLines
                count={rows.length}
                height={18}
                columns={mode === 'split' ? 5 : 3}
                render={(start, end) =>
                  rows.slice(start, end).map((row, offset) => {
                    const i = start + offset;
                    const line = row.right ?? row.left!;
                    if (mode === 'split')
                      return (
                        <tr key={`${index}:${i}`}>
                          <td
                            className={`fx-diff-n ${row.left?.kind === 'removed' ? 'fx-diff-removed' : ''}`}
                          >
                            {number('before', row.left?.before)}
                          </td>
                          <td
                            className={`fx-diff-code ${row.left ? (row.left.kind === 'removed' ? 'fx-diff-removed' : '') : 'fx-diff-empty'}`}
                          >
                            {row.left ? (
                              <>
                                {row.left.kind === 'removed' && (
                                  <>
                                    <span aria-hidden="true">− </span>
                                    <span className="fx-sr">Removed: </span>
                                  </>
                                )}
                                {source(row.left, index)}
                              </>
                            ) : (
                              ' '
                            )}
                          </td>
                          <td className="fx-diff-mid" />
                          <td className={`fx-diff-n ${row.right?.kind === 'added' ? 'fx-diff-added' : ''}`}>
                            {number('after', row.right?.after)}
                          </td>
                          <td
                            className={`fx-diff-code ${row.right ? (row.right.kind === 'added' ? 'fx-diff-added' : '') : 'fx-diff-empty'}`}
                          >
                            {row.right ? (
                              <>
                                {row.right.kind === 'added' && (
                                  <>
                                    <span aria-hidden="true">+ </span>
                                    <span className="fx-sr">Added: </span>
                                  </>
                                )}
                                {source(row.right, index)}
                              </>
                            ) : (
                              ' '
                            )}
                          </td>
                        </tr>
                      );
                    const modified =
                      mode === 'inline' && row.left?.kind === 'removed' && row.right?.kind === 'added';
                    const words = modified ? wordChanges(row.left!.text, row.right!.text) : undefined;
                    return (
                      <tr
                        className={`fx-diff-line fx-diff-${modified ? 'modified' : line.kind}`}
                        key={`${index}:${i}`}
                      >
                        <td className="fx-diff-n">{number('before', row.left?.before)}</td>
                        <td className="fx-diff-n">{number('after', row.right?.after)}</td>
                        <td className="fx-diff-code">
                          <span className="fx-diff-sign" aria-hidden="true">
                            {modified
                              ? '~'
                              : line.kind === 'added'
                                ? '+'
                                : line.kind === 'removed'
                                  ? '−'
                                  : ' '}
                          </span>
                          {line.kind === 'added' && !modified && <span className="fx-sr">Added: </span>}
                          {line.kind === 'removed' && !modified && <span className="fx-sr">Removed: </span>}
                          {words ? (
                            <SyntaxLine
                              file={file}
                              text={words.map(word => word.text).join('')}
                              words={words}
                              plain={plain}
                              range={`${index}:${i}:inline`}
                              blob={comparison.afterBlob ?? undefined}
                            />
                          ) : (
                            source(line, index)
                          )}
                        </td>
                      </tr>
                    );
                  })
                }
              />
            </Fragment>
          );
        })}
      </table>
    </div>
  );
});
