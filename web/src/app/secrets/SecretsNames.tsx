// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Names: every set's names, A to Z, the first 100 a set, with setup guidance for missing Checks values.
import { Band, Region, State, Who } from '../../ds';
import { checksSetCommand } from '../../../../src/secret-names';
import { SecretCommand } from './SecretCommand';
import { count, exact, nameTotal, relative, setLabel, type Overview } from './secrets-model';

export function SecretsNames({
  data,
  now,
  onMore,
  busy,
  missingChecks,
}: {
  data: Overview;
  now: number;
  onMore: (kind: 1 | 2 | 3, part: 'names') => void;
  busy: boolean;
  missingChecks: readonly string[];
}) {
  const total = nameTotal(data);
  if (!total && !missingChecks.length)
    return (
      <Region title="Names" count={0}>
        <div className="empty">
          <h3>No names yet</h3>
          <p>
            Names appear here once someone sets the first one in a terminal. Values never come to this page.
          </p>
          <SecretCommand command="nforge secret set NAME" label="Copy: nforge secret set NAME" />
          <span className="t3">
            Have a .env file? <code className="mono">nforge secret import</code>
          </span>
        </div>
      </Region>
    );
  return (
    <Region title="Names" count={total} hint="A to Z in each set · values are set and used in a terminal">
      <div className="th secret-name" aria-hidden="true">
        <span>Name</span>
        <span>Kind</span>
        <span>Changed</span>
        <span>By</span>
      </div>
      {data.sets.map(set => {
        const names = set.names;
        if (!names) return null;
        return (
          <div key={set.kind}>
            <Band
              title={setLabel(set.kind)}
              count={names.total}
              hint={
                set.kind === 1 ? (
                  <>
                    what people and agents run with: <code>nforge run -- &lt;cmd&gt;</code> · new computers:{' '}
                    {set.sharing === 'automatic' ? 'Automatic' : 'Confirm'}
                  </>
                ) : set.kind === 2 ? (
                  'what a check receives, and only the names it declares'
                ) : undefined
              }
            />
            {set.kind === 2 && missingChecks.length ? (
              <div className="secret-checks-hint">
                <p>
                  No value in Checks for these names from <code>.env.example</code>. Set the values your check
                  uses.
                </p>
                <pre className="mono" translate="no">
                  {missingChecks.map(checksSetCommand).join('\n')}
                </pre>
              </div>
            ) : null}
            {names.page.map(row => (
              <div className="row secret-name" key={row.name}>
                <span className="secret-nm">
                  <span className="ttl" translate="no">
                    {row.name}
                  </span>
                  {row.rotate ? (
                    <State word="Needs you" state="waiting">
                      To rotate
                    </State>
                  ) : null}
                  {row.waits ? (
                    <span className="t3">{count(row.waits, 'proposal waits', 'proposals wait')}</span>
                  ) : null}
                </span>
                <span className="secret-k">{row.kind === 2 ? 'file' : 'env'}</span>
                <span className="secret-ch" title={exact(row.at)}>
                  v{row.version.toLocaleString()} · {relative(row.at, now)}
                </span>
                <span className="secret-by">
                  {row.by ? <Who handle={row.by} /> : <span className="t3">Not reported</span>}
                </span>
              </div>
            ))}
            {names.next ? (
              <p className="pf">
                {names.page.length.toLocaleString()} of {count(names.total, 'name')} shown ·{' '}
                <button
                  type="button"
                  className="btn sm ghost"
                  disabled={busy}
                  onClick={() => onMore(set.kind, 'names')}
                >
                  Show the next 100
                </button>
              </p>
            ) : null}
          </div>
        );
      })}
    </Region>
  );
}
