// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Names-first Secrets, on the shared design system. The protocol is gated: the live route uses a metadata-only
// unavailable stub. Fixtures exercise the future view without adding a public fixture route or any secret endpoint.
import { useState } from 'react';
import { Band, Key, Region, Row, State, Who } from '../../ds';
import { SecretCommand } from './SecretCommand';
import { SecretsDetails, SecretsGuidance } from './SecretsDetails';
import {
  secretCount,
  secretPageCount,
  secretSetCommand,
  secretSetLabel,
  secretsView,
  type SecretSet,
  type SecretsView,
} from './secrets-model';
import './secrets.css';

function Names({ sets }: { sets: readonly SecretSet[] }) {
  const shown = sets.reduce((n, set) => n + set.names.length, 0);
  const total = sets.reduce((n, set) => n + set.nameTotal, 0);
  return (
    <Region title="Names" count={total} hint="values are set and used in a terminal, never shown here">
      <div className="th secret-name" aria-hidden="true">
        <span>Name</span>
        <span>Changed</span>
        <span>By</span>
        <span />
      </div>
      {sets.map(set => (
        <div key={set.id}>
          <Band
            title={secretSetLabel(set.id)}
            count={set.nameTotal}
            hint={
              set.id === 'development' ? (
                <>
                  what people and agents run with: <code>nforge run -- &lt;cmd&gt;</code>
                </>
              ) : (
                'what a check receives, and only the names it declares'
              )
            }
          />
          {set.names.length === 0 ? <p className="quietline">No names in this page.</p> : null}
          {set.names.map(name => (
            <Row key={name.name} cols="" className="secret-name" dense={total > 20}>
              <div className="secret-nm">
                <span className="ttl mono" translate="no">
                  {name.name}
                </span>
                {name.note ? <span className="sub meta">{name.note}</span> : null}
              </div>
              <span className="t2 tnum secret-changed">
                <span className="sr">Changed </span>
                {name.changed}
              </span>
              <span className="cut">
                {name.by ? <Who handle={name.by} /> : <span className="t3">Not reported</span>}
              </span>
              <span className="secret-actions">
                {name.state ? (
                  <>
                    <State word="Needs you" state={name.state === 'missing' ? 'failed' : 'waiting'}>
                      {name.state === 'missing'
                        ? 'No value'
                        : name.state === 'through-checks'
                          ? 'To rotate, through checks'
                          : 'To rotate'}
                    </State>
                    <SecretCommand command={secretSetCommand(name.name, set.id)} small />
                  </>
                ) : null}
              </span>
            </Row>
          ))}
          {set.names.length < set.nameTotal ? (
            <p className="pf">{secretPageCount(set.names.length, set.nameTotal, 'name')} shown.</p>
          ) : null}
        </div>
      ))}
      {shown < total ? (
        <p className="pf">{secretPageCount(shown, total, 'name')} shown across both sets.</p>
      ) : null}
    </Region>
  );
}

export function SecretsScreen({ view, onRetry }: { view: SecretsView; onRetry?: () => void }) {
  const [cli, setCli] = useState(false);
  const metadata =
    view.status === 'ready' ? view.metadata : view.status === 'failed' ? view.previous : undefined;
  const total = metadata?.sets.reduce((n, set) => n + set.nameTotal, 0) ?? 0;
  const empty = metadata && total === 0;
  const sentence =
    view.status === 'unavailable' ? (
      <b>Sealed secrets are not connected yet.</b>
    ) : view.status === 'forbidden' ? (
      <b>Secrets are for people who can write.</b>
    ) : view.status === 'loading' ? (
      <b>Loading secrets…</b>
    ) : view.status === 'failed' ? (
      <>
        <b>Secrets could not be loaded.</b> Nothing was changed.
      </>
    ) : empty ? (
      <b>This project has no secrets yet.</b>
    ) : metadata?.rotationTotal ? (
      <b>{secretCount(metadata.rotationTotal, 'secret needs', 'secrets need')} a new value.</b>
    ) : metadata?.missingTotal ? (
      <>
        <b>
          {secretCount(total, 'secret')} in {secretCount(metadata.sets.length, 'set')}.
        </b>{' '}
        {secretCount(metadata.missingTotal, 'name has', 'names have')} no value.
      </>
    ) : metadata?.waitingTotal ? (
      <>
        <b>{secretCount(metadata.waitingTotal, 'computer is', 'computers are')} waiting.</b>{' '}
        {secretCount(total, 'secret')} in {secretCount(metadata.sets.length, 'set')}.
      </>
    ) : metadata?.recovery ? (
      <>
        <b>Only one computer can open these secrets.</b> {secretCount(total, 'secret')} in{' '}
        {secretCount(metadata.sets.length, 'set')}.
      </>
    ) : (
      <>
        <b>
          {secretCount(total, 'secret')} in {secretCount(metadata?.sets.length ?? 0, 'set')}.
        </b>{' '}
        Nothing needs a new value.
      </>
    );
  return (
    <div className="secrets-screen">
      <div className="head">
        <h1>Secrets</h1>
        <p className="sit">{sentence}</p>
        <div className="tools">
          {metadata && !empty ? <SecretCommand command="nforge secret set NAME" /> : null}
          <Key className="cli" aria-controls="secrets-cli" aria-expanded={cli} onClick={() => setCli(!cli)}>
            <span className="mono">nforge agent . secrets</span>
            <span className="t3">Proposed</span>
          </Key>
        </div>
      </div>
      {cli ? (
        <pre className="cli-out mono" id="secrets-cli">
          Proposed: nforge agent . secrets &apos;{'{}'}&apos;{`\n`}Names, sets, holders and state only. Values
          are never returned.{`\n`}This command awaits the sealed-secret protocol.
        </pre>
      ) : null}
      {view.status === 'unavailable' ? <SecretsGuidance /> : null}
      {view.status === 'forbidden' ? (
        <p className="quietline">Names, holders and history are visible to people with write access.</p>
      ) : null}
      {view.status === 'loading' ? (
        <div className="pad" role="status" aria-busy="true">
          <span className="sr">Loading secret metadata.</span>
          <div className="sk" />
        </div>
      ) : null}
      {view.status === 'failed' ? (
        <div className="notice" data-st="failed">
          <State word="Check failed">Could not load</State>
          <p>
            {metadata
              ? `Below is what this browser last showed${view.lastShown ? `, at ${view.lastShown}` : ''}.`
              : 'No secret metadata was returned.'}
          </p>
          {onRetry ? (
            <Key size="sm" onClick={onRetry}>
              Retry
            </Key>
          ) : null}
        </div>
      ) : null}
      {empty ? (
        <Region title="Names" count={0}>
          <div className="empty">
            <h2>No names yet</h2>
            <p>
              Sealed sets are planned. Today, checks use the names declared in their definition and the values
              already on their runner.
            </p>
            <a
              className="lk"
              href="https://github.com/NanthAI/nanthai-forge/blob/main/docs/security.md#secrets-for-checks"
            >
              Where check secrets go
            </a>
          </div>
        </Region>
      ) : null}
      {metadata && !empty ? (
        <>
          {metadata.rotationTotal ? (
            <div className="notice" data-st="waiting">
              <State word="Needs you">{secretCount(metadata.rotationTotal, 'to rotate', 'to rotate')}</State>
              <p>
                A removed holder may still know these values. Replace each at its provider, then set it in a
                terminal.
              </p>
              <SecretCommand command="nforge secret rotate-list" />
            </div>
          ) : null}
          {metadata.recovery ? (
            <div className="notice" data-st="waiting">
              <State word="Needs you">One holder</State>
              <p>
                A non-reissuable key has one holder and no passkey envelope. Another holder is needed for
                recovery. The separate secret-envelope passkey path is not available yet.
              </p>
            </div>
          ) : null}
          <div className="secret-frame">
            <Names sets={metadata.sets} />
            <SecretsDetails metadata={metadata} />
          </div>
        </>
      ) : null}
    </div>
  );
}

export default function Secrets() {
  return <SecretsScreen view={secretsView()} />;
}
