// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { checkEvidence } from '../../../../src/run-evidence';
import { Key } from '../../ds';
import { useMoreRows } from './use-more-rows';

type Check = NonNullable<ReturnType<typeof checkEvidence>>;

const scopeNames = {
  contract: 'contract tests',
  scoped: 'changed-file selection',
  audit: 'main audit',
  probe: 'diagnostic check',
  full: 'full check',
  docs: 'documentation check',
};

export function checkScope(selection: Check['selection']) {
  const scope = selection?.effective ?? selection?.mode;
  if (!scope || !Object.hasOwn(scopeNames, scope)) return 'check scope not reported';
  return scopeNames[scope] + (selection?.effective ? '' : ' requested');
}

export function ShardCount({ shards }: { shards: Check['shards'] }) {
  const { total, completed, passed, failed } = shards;
  const marks = Math.min(24, total ?? completed);
  const green = Math.min(passed, Math.max(0, marks - failed));
  return (
    <>
      {marks > 0 ? (
        <>
          <span className="shards" aria-hidden="true">
            {Array.from({ length: marks }, (_, i) => (
              <i key={i} className={i < green ? 'ok' : i < green + failed ? 'bad' : undefined} />
            ))}
          </span>{' '}
        </>
      ) : null}
      {completed.toLocaleString()}
      {total === null
        ? ` ${completed === 1 ? 'shard' : 'shards'} completed · total not reported`
        : ` of ${total.toLocaleString()} ${total === 1 ? 'shard' : 'shards'}`}
      {failed > 0 ? ` · ${failed.toLocaleString()} failed` : ''}
    </>
  );
}

export function RequestedTests({ tests }: { tests: string[] }) {
  const { shown, showMore, focusNewRow } = useMoreRows(20);
  return (
    <details>
      <summary className="quietline">
        <span className="tw" aria-hidden="true" /> Tests named in the request ({tests.length.toLocaleString()}
        )
      </summary>
      <ul className="proof-tests">
        {tests.slice(0, shown).map((test, index) => (
          <li className="mono any" key={index} tabIndex={-1} ref={element => focusNewRow(element, index)}>
            {test}
          </li>
        ))}
      </ul>
      {shown < tests.length ? (
        <div className="pad">
          <Key size="sm" onClick={() => showMore(20)}>
            Show {Math.min(20, tests.length - shown)} more {tests.length - shown === 1 ? 'test' : 'tests'}
          </Key>
        </div>
      ) : null}
    </details>
  );
}
