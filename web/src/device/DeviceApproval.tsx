import { ErrorToast } from '../ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';
import { Glyph } from '../ui/Glyph';
import { Button, Callout } from '../ui/primitives';
import { CODE_LENGTH, codeComplete, expiresIn, formatCode, scopeWords } from './code';

export type DeviceRequest = { name: string; scope: string; expiresAt: number; state: string };
export type DevicePhase =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  | { kind: 'enter' }
  | { kind: 'checking' }
  | { kind: 'review'; request: DeviceRequest }
  | { kind: 'approved'; name: string }
  | { kind: 'denied'; name: string }
  | { kind: 'problem'; problem: 'expired' | 'used' };

/**
 * The /device approval card. Pure: the container supplies the phase, the code and the actions, so
 * every state renders the same in review fixtures and in the signed-in app.
 */
export function DeviceApproval({
  phase,
  code,
  setCode,
  find,
  decide,
  restart,
  busy = false,
  error = '',
  signIn,
  now,
  settingsHref = '/?surface=account&settings=account',
}: {
  phase: DevicePhase;
  code: string;
  setCode: (code: string) => void;
  find: () => void;
  decide: (approve: boolean) => void;
  restart: () => void;
  busy?: boolean;
  error?: string;
  /** The sign-in control; Clerk's button in the app. */
  signIn: ReactNode;
  now: number;
  settingsHref?: string;
}) {
  const head = (title: string, lead?: ReactNode, tone: 'brand' | 'passed' | 'plain' = 'brand') => (
    <header className="fx-dv-head">
      <span className={`fx-dv-icon fx-dv-icon-${tone}`} aria-hidden="true">
        <Glyph name={tone === 'passed' ? 'passed' : 'terminal'} size={20} />
      </span>
      <h1>{title}</h1>
      {lead && <p className="fx-dv-lead">{lead}</p>}
    </header>
  );
  const codeChip = code && (
    <p className="fx-dv-codeline">
      Code <code className="fx-dv-chip">{formatCode(code)}</code>
    </p>
  );
  let body: ReactNode;
  switch (phase.kind) {
    case 'loading':
      body = (
        <>
          {head('Approve a terminal sign-in')}
          <p className="fx-dv-status" role="status">
            Checking your session…
          </p>
        </>
      );
      break;
    case 'signed-out':
      body = (
        <>
          {head(
            'Approve a terminal sign-in',
            <>
              <code>nforge login</code> is waiting for you. Sign in with the account it should use.
            </>,
          )}
          {codeChip}
          <div className="fx-dv-actions fx-dv-stack">{signIn}</div>
        </>
      );
      break;
    case 'enter':
    case 'checking':
      body = (
        <>
          {head('Approve a terminal sign-in', 'Enter the code your terminal printed.')}
          <form
            className="fx-dv-form"
            onSubmit={event => {
              event.preventDefault();
              if (codeComplete(code)) find();
            }}
          >
            <label htmlFor="fx-dv-code">Code from your terminal</label>
            <input
              id="fx-dv-code"
              className="fx-dv-input"
              value={formatCode(code)}
              onChange={event => setCode(formatCode(event.target.value))}
              onPaste={event => {
                event.preventDefault();
                setCode(formatCode(event.clipboardData.getData('text')));
              }}
              placeholder="XXXXX-XXXXX"
              maxLength={CODE_LENGTH + 1}
              inputMode="text"
              autoCapitalize="characters"
              autoComplete="one-time-code"
              spellCheck={false}
              disabled={phase.kind === 'checking'}
              aria-invalid={Boolean(error) || undefined}
            />
            <Button
              type="submit"
              variant="primary"
              size="lg"
              disabled={!codeComplete(code) || phase.kind === 'checking'}
            >
              {phase.kind === 'checking' ? 'Finding…' : 'Continue'}
            </Button>
          </form>
        </>
      );
      break;
    case 'review': {
      const { request } = phase;
      body = (
        <>
          {head('Approve this terminal?', 'Only approve if you just ran nforge login yourself.')}
          <dl className="fx-dv-facts">
            <div>
              <dt>Device</dt>
              <dd>
                <b>{request.name}</b>
              </dd>
            </div>
            <div>
              <dt>Access</dt>
              <dd>{scopeWords(request.scope)}</dd>
            </div>
            <div>
              <dt>Lasts</dt>
              <dd>30 days, or until you revoke it</dd>
            </div>
            <div>
              <dt>Code</dt>
              <dd>
                <code className="fx-dv-chip">{formatCode(code)}</code>{' '}
                <span className="fx-faint">expires {expiresIn(request.expiresAt, now)}</span>
              </dd>
            </div>
          </dl>
          {request.state === 'pending' ? (
            <div className="fx-dv-actions">
              <Button variant="primary" size="lg" disabled={busy} onClick={() => decide(true)}>
                Approve
              </Button>
              <Button size="lg" disabled={busy} onClick={() => decide(false)}>
                Deny
              </Button>
            </div>
          ) : (
            <Callout tone="info">This code already has a decision.</Callout>
          )}
        </>
      );
      break;
    }
    case 'approved':
      body = (
        <>
          {head(
            'Approved',
            <>
              <b>{phase.name}</b> is signed in. You can return to your terminal.
            </>,
            'passed',
          )}
          <p className="fx-dv-foot">
            <a href={settingsHref}>Signed-in devices</a> lists it; revoke it there any time.
          </p>
        </>
      );
      break;
    case 'denied':
      body = (
        <>
          {head('Denied', <>The terminal on {phase.name} will not be signed in.</>, 'plain')}
          <div className="fx-dv-actions">
            <Button onClick={restart}>Enter another code</Button>
          </div>
        </>
      );
      break;
    case 'problem':
      body = (
        <>
          {head('Terminal sign-in', '', 'plain')}
          <ErrorToast
            error={
              phase.problem === 'expired'
                ? 'This code has expired. Run nforge login again for a new one.'
                : 'This code was already used. Run nforge login again if your terminal is still waiting.'
            }
          />
          <div className="fx-dv-actions">
            <Button onClick={restart}>Enter another code</Button>
          </div>
        </>
      );
  }
  return (
    <div className="fx-page fx-dv">
      <section className="fx-panel fx-dv-card" aria-live="polite">
        {body}
        {error && <ErrorToast fieldIds={['fx-dv-code']}>{error}</ErrorToast>}
      </section>
    </div>
  );
}
