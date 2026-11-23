// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { Avatar, Band, Key, Region, Row, State, Who } from '../../ds';
import { SecretCommand } from './SecretCommand';
import { secretPageCount, secretSetLabel, type SecretsMetadata } from './secrets-model';

/** Present-day guidance stays separate from the protocol proposal. No pretend setup or storage mutation. */
export function SecretsGuidance() {
  return (
    <Region title="Secrets for checks">
      <div className="pad beside">
        <div className="secret-guidance">
          <p>
            Declare environment names in <code>env</code> and credential names in <code>credentials</code> on
            the check definition. Their values must already be in the runner’s environment or CI secret store.
          </p>
          <p>
            Secret Objects do not supply check credentials. They remain available on the current account
            screen until their agreed export and retirement.
          </p>
        </div>
        <div className="secret-guidance">
          <p>
            The planned shared store is the sealed <b>Development</b> and <b>Checks</b> sets. Machine-key
            setup and declared-name delivery await the security-reviewed protocol.
          </p>
          <p>
            Names and holders will appear here when it is connected. This page never asks for or shows a
            secret value.
          </p>
        </div>
      </div>
    </Region>
  );
}

export function SecretsDetails({ metadata }: { metadata: SecretsMetadata }) {
  return (
    <div className="secret-side">
      <Region title="Who can open them" hint="metadata only">
        {metadata.waitingTotal ? (
          <>
            <Band title="Waiting computers" count={metadata.waitingTotal} />
            {metadata.waiting.map(wait => (
              <Row key={wait.id} cols="" className="secret-holder">
                <div className="secret-nm">
                  <Who handle={wait.handle} />
                  <span className="sub">
                    Computer <bdi className="mono">{wait.code}</bdi> asks to open {secretSetLabel(wait.set)}.
                    Finish in a terminal that already opens it; this page cannot approve it.
                  </span>
                </div>
                <SecretCommand command="nforge secret share" small />
              </Row>
            ))}
            {metadata.waiting.length < metadata.waitingTotal ? (
              <p className="pf">
                {secretPageCount(metadata.waiting.length, metadata.waitingTotal, 'computer')} shown.
              </p>
            ) : null}
          </>
        ) : null}
        {metadata.sets.map(set => (
          <div key={set.id}>
            <Band title={secretSetLabel(set.id)} count={set.holderTotal} />
            {set.holderTotal === 0 ? (
              <p className="quietline">
                <State word="Check failed">Nobody can open {secretSetLabel(set.id)}</State> Its names remain
                as a list to set again.
              </p>
            ) : null}
            {set.holders.map(holder => (
              <Row key={holder.id} cols="" className="secret-holder">
                <div className="secret-nm">
                  {holder.kind === 'person' ? (
                    <Who handle={holder.label} />
                  ) : (
                    <span className="who">
                      <Avatar handle={holder.label} />
                      <span className="mono cut" title={holder.label}>
                        {holder.label}
                      </span>
                    </span>
                  )}
                  <span className="sub meta cut" title={holder.detail}>
                    {holder.detail}
                  </span>
                </div>
                {holder.canRemove ? (
                  <Key
                    size="sm"
                    kind="ghost"
                    disabled
                    title="Holder removal awaits the sealed-secret protocol"
                  >
                    Remove
                  </Key>
                ) : null}
              </Row>
            ))}
            {set.holders.length < set.holderTotal ? (
              <p className="pf">{secretPageCount(set.holders.length, set.holderTotal, 'holder')} shown.</p>
            ) : null}
          </div>
        ))}
      </Region>
      <Region title="New computers" hint="Development sharing">
        {metadata.canManageSharing ? (
          <div role="radiogroup" aria-label="Development sharing (not connected)">
            {(['automatic', 'confirm'] as const).map(mode => (
              <button
                key={mode}
                type="button"
                className="row choice"
                role="radio"
                aria-checked={metadata.sharing === mode}
                disabled
              >
                <span className="rd" aria-hidden="true" />
                <span>
                  <b>{mode === 'automatic' ? 'Automatic' : 'Confirm'}</b>
                  <span className="sub">
                    {mode === 'automatic'
                      ? 'The next teammate’s terminal shares it. Every holder is told, with Remove and rotate.'
                      : 'A holder compares four words with the new person, in a terminal.'}
                  </span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className="quietline">
            <b>{metadata.sharing === 'automatic' ? 'Automatic.' : 'Confirm.'}</b>{' '}
            {metadata.sharing === 'automatic'
              ? 'The next holder’s terminal shares Development. Every holder is told, with Remove and rotate.'
              : 'A holder compares four words with the new person, in a terminal.'}
          </p>
        )}
        <p className="quietline">
          Only owner devices and machine keys hold the Checks key. Other write members propose values; a
          person approves them in a terminal.
        </p>
      </Region>
      <Region title="Recent" hint="newest first, up to 50">
        {metadata.recent.length ? (
          metadata.recent.map(event => (
            <Row key={event.id} dense cols="" className="tl secret-recent">
              <span className="num">{event.when}</span>
              <span className="any">
                {event.text}
                {event.automatic ? <span className="cnt">auto</span> : null}
              </span>
            </Row>
          ))
        ) : (
          <p className="quietline">No recent changes reported.</p>
        )}
      </Region>
    </div>
  );
}
