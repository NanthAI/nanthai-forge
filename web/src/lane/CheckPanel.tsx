// SPDX-License-Identifier: Apache-2.0
import { Glyph } from '../ui/Glyph';
import type { ReactNode } from 'react';
import { Panel, StatusPill } from '../ui/primitives';
import { age, checkStatus } from '../ui/status';

export type RunView = {
  id: string;
  status: string;
  check?: string;
  checkSelection?: { scope: 'docs' | 'interaction' | 'scoped' | 'full'; reason: string; tests: string[] };
  startedAt?: string;
  endedAt?: string;
  exitCode?: number | null;
};

/** Names of failing tests from a bounded failure summary (node:test spec/TAP lines, deduplicated). */
export function failingTests(summary: string): string[] {
  const names = summary
    .split('\n')
    .map(line => line.trim())
    .filter(
      line =>
        (line.startsWith('✖') && !/failing tests:?$/.test(line)) || /^(?:\[test\] )?not ok \d+ - /.test(line),
    )
    .map(line =>
      line.replace(/^(?:✖\s*|(?:\[test\] )?not ok \d+ - )/, '').replace(/\s*\(\d+(\.\d+)?ms\)$/, ''),
    );
  return [...new Set(names)];
}

export function checkDuration(run: { startedAt?: string; endedAt?: string }) {
  if (!run.endedAt || !run.startedAt) return '';
  const seconds = Math.round((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/** The latest check on the exact View, failures first, receipts behind a disclosure. */
export function CheckPanel({
  run,
  summary,
  now,
  actions,
  mainIncluded,
  overlapCount,
  children,
  queue,
}: {
  queue?: import('../cockpit/queue-model').QueueFact;
  run: RunView | null;
  /** Failure output; null when it lives only on the machine that ran the check. */
  summary?: string | null;
  now: number;
  actions?: ReactNode;
  mainIncluded?: boolean;
  overlapCount?: number;
  children?: ReactNode;
}) {
  if (!run) return null;
  const neutral = queue?.state === 'not-run' || queue?.historical;
  const state = neutral ? { tone: 'plain' as const, label: 'Not run' } : checkStatus(run.status);
  const tests = !neutral && summary ? failingTests(summary) : [];
  return (
    <Panel
      title={
        <span className="fx-check-title">
          Check{' '}
          <StatusPill tone={state.tone}>
            {run.check && <>{run.check} · </>}
            {run.checkSelection && <>{run.checkSelection.scope} · </>}
            {state.label}
            {run.exitCode != null ? ` · exit ${run.exitCode}` : ''}
            {checkDuration(run) ? ` · ${checkDuration(run)}` : ''}
          </StatusPill>
        </span>
      }
      actions={
        <>
          <span className="fx-faint">{age(run.endedAt ?? run.startedAt, now, true)}</span>
          {actions}
        </>
      }
    >
      {(mainIncluded !== undefined || (overlapCount ?? 0) > 0) && (
        <div className="fx-check-gates">
          {mainIncluded !== undefined && (
            <div className="fx-check-gate">
              <Glyph
                name={mainIncluded ? 'passed' : 'sync'}
                size={12}
                className={mainIncluded ? 'fx-c-passed' : 'fx-c-waiting'}
              />
              <div>
                <b>{mainIncluded ? 'Includes everything on main' : 'main has moved since this check'}</b>
              </div>
            </div>
          )}
          {overlapCount !== undefined && overlapCount > 0 && (
            <div className="fx-check-gate">
              <Glyph
                name={overlapCount ? 'overlap' : 'passed'}
                size={12}
                className={overlapCount ? 'fx-c-waiting' : 'fx-c-passed'}
              />
              <div>
                <b>
                  {overlapCount
                    ? `${overlapCount} open ${overlapCount === 1 ? 'Lane overlaps' : 'Lanes overlap'}`
                    : 'No overlapping open Lanes'}
                </b>
              </div>
            </div>
          )}
        </div>
      )}
      {run.status === 'failed' && tests.length > 0 && (
        <div className="fx-failures">
          {tests.length > 0 && (
            <ul className="fx-failing">
              {tests.slice(0, 8).map(name => (
                <li key={name}>
                  <span className="fx-fail-x" aria-hidden="true">
                    ✖
                  </span>
                  {name}
                </li>
              ))}
              {tests.length > 8 && <li className="fx-faint">and {tests.length - 8} more</li>}
            </ul>
          )}
        </div>
      )}
      {children}
    </Panel>
  );
}
