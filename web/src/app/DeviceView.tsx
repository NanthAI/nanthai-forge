// SPDX-License-Identifier: Apache-2.0
import type { FormEvent } from 'react';
import { Key, State } from '../ds';
import { DeviceFacts } from './DeviceFacts';
import type { DeviceSettings as Settings } from './access-contract';
import { codeComplete, expiresIn, formatCode, scopeWords } from '../device/code';
import { UntrustedName } from '../device/DeviceName';
import { PublicFrame } from './frames';
import { hrefFor } from './paths';
export type DeviceRequest = {
  name: string;
  needsConfirmation?: boolean;
  /** False when the account has no linked GitHub identity: the GitHub check is not offered. */
  github?: boolean;
  scope: 'cli' | 'coordination';
  expiresAt: number;
  state: string;
  device?: {
    id: string;
    code: string;
    known: boolean;
    approvedAt: number | null;
    settings: Settings;
    projectName: string | null;
  };
};
export type DevicePhase =
  | { kind: 'enter' }
  | { kind: 'checking' }
  | { kind: 'review'; request: DeviceRequest }
  | { kind: 'done'; approved: boolean; name: string }
  | { kind: 'problem'; problem: 'expired' | 'used' };

/** What a code that already has a decision says, by the state the server recorded. */
function decidedWords(state: string) {
  if (state === 'approved' || state === 'consumed')
    return 'This code was already approved. Return to your terminal; it signs in on its own.';
  if (state === 'removed')
    return 'This device was removed. Run nforge login again to approve a new key; its saved work stays on Forge.';
  if (state === 'denied') return 'This code was denied. Run nforge login again for a new one.';
  return 'This code already has a decision.';
}

/** The /-/device page itself. Pure: the container supplies the phase, the code and the actions. */
export function DeviceView({
  phase,
  name,
  setName,
  settings,
  setSettings,
  code,
  setCode,
  typed,
  setTyped,
  requireTyped,
  busy,
  problem,
  viewerHandle,
  now,
  submit,
  decide,
  restart,
  confirmPasskey,
  confirmGithub,
}: {
  phase: DevicePhase;
  name?: string;
  setName?: (name: string) => void;
  settings?: Settings;
  setSettings?: (settings: Settings) => void;
  code: string;
  setCode: (code: string) => void;
  typed: string;
  setTyped: (typed: string) => void;
  /** The code arrived in a link: it is not shown, and approving needs it typed from the terminal first. */
  requireTyped: boolean;
  busy: boolean;
  problem: string | null;
  viewerHandle: string | undefined;
  now: number;
  submit: (event: FormEvent) => void;
  decide: (approve: boolean) => void;
  restart: () => void;
  confirmPasskey?: () => void;
  confirmGithub?: () => void;
}) {
  const error = problem ? (
    <p className="err" role="alert">
      <State word="Check failed" state="failed">
        {problem}
      </State>
    </p>
  ) : null;
  const another = (
    <Key size="lg" className="wide-btn" onClick={restart}>
      Enter another code
    </Key>
  );
  let body;
  if (phase.kind === 'review') {
    const { request } = phase;
    const pending = request.state === 'pending',
      lapsed = request.expiresAt <= now;
    body = (
      <>
        <div className="intro">
          <h1>
            {request.device?.known
              ? 'Sign this device in again?'
              : request.device
                ? 'Make this device yours?'
                : 'Approve this device?'}
          </h1>
          <p>
            Approve only if you just ran <code>nforge login</code> yourself. If you did not, deny it.
          </p>
        </div>
        <div className="blk">
          {request.device ? (
            <DeviceFacts
              request={request}
              viewerHandle={viewerHandle}
              name={name}
              setName={setName}
              settings={settings}
              setSettings={setSettings}
              busy={busy}
            />
          ) : (
            <dl className="pad facts">
              <dt>Acts for</dt>
              <dd>{viewerHandle ? `@${viewerHandle}` : 'You'}</dd>
              <dt>Access</dt>
              <dd>{scopeWords(request.scope)}</dd>
              <dt>Lasts</dt>
              <dd>30 days, or until you revoke it</dd>
              <dt>Code expires</dt>
              <dd>{expiresIn(request.expiresAt, now)}</dd>
              <dt>Name</dt>
              <dd data-untrusted="true">
                <UntrustedName name={request.name} noteClass="t3" />
              </dd>
            </dl>
          )}
          <div className="pad signin">
            {!pending ? (
              <p>{decidedWords(request.state)}</p>
            ) : lapsed ? (
              <>
                <p>This code has expired. Run nforge login again for a new one.</p>
                {another}
              </>
            ) : (
              <>
                {requireTyped ? (
                  <label className="f">
                    Type the code your terminal shows
                    <input
                      className="inp lg mono"
                      name="confirm-code"
                      autoComplete="off"
                      autoCapitalize="characters"
                      spellCheck={false}
                      placeholder="XXXXX-XXXXX"
                      value={typed}
                      onChange={event => setTyped(formatCode(event.target.value))}
                    />
                  </label>
                ) : null}
                {request.needsConfirmation ? (
                  <div className="btns">
                    <Key onClick={confirmPasskey} disabled={busy}>
                      Check with passkey
                    </Key>
                    {request.github === false ? null : (
                      <Key onClick={confirmGithub} disabled={busy}>
                        Check with GitHub
                      </Key>
                    )}
                  </div>
                ) : null}
                {error}
                <Key
                  kind="primary"
                  size="lg"
                  className="wide-btn"
                  onClick={() => decide(true)}
                  disabled={
                    busy ||
                    request.needsConfirmation ||
                    (requireTyped &&
                      (code ? formatCode(typed) !== formatCode(code) : !codeComplete(typed))) ||
                    Boolean(request.device && !request.device.known && !(name ?? request.name).trim())
                  }
                >
                  {request.device?.known
                    ? 'Sign it in again'
                    : request.device
                      ? 'Approve this device'
                      : 'Approve'}
                </Key>
                <Key size="lg" className="wide-btn" onClick={() => decide(false)} disabled={busy}>
                  Deny
                </Key>
              </>
            )}
          </div>
        </div>
      </>
    );
  } else if (phase.kind === 'done')
    body = (
      <div className="intro">
        <h1>{phase.approved ? 'Approved' : 'Denied'}</h1>
        <p>
          The terminal named <UntrustedName name={phase.name} />{' '}
          {phase.approved
            ? 'is signed in. Return to the terminal; it continues on its own.'
            : 'will not be signed in. No device was added.'}
        </p>
        <p>
          <a className="lk" href={hrefFor({ frame: 'account', place: 'devices' })}>
            Sign-in and devices
          </a>
        </p>
      </div>
    );
  else if (phase.kind === 'problem')
    body = (
      <>
        <div className="intro">
          <h1>{phase.problem === 'expired' ? 'This code has expired' : 'This code was already answered'}</h1>
          <p>
            {phase.problem === 'expired'
              ? 'Codes last 10 minutes. Run nforge login again for a new one.'
              : 'Return to the terminal; it already has its answer.'}
          </p>
        </div>
        <div className="blk">
          <div className="pad signin">{another}</div>
        </div>
      </>
    );
  else if (requireTyped)
    // The code from a link is being checked; it is not shown.
    body = (
      <div className="intro" aria-busy="true">
        <h1>Checking the code from your link…</h1>
      </div>
    );
  else
    body = (
      <>
        <div className="intro">
          <h1>Type the code your terminal printed</h1>
          <p>
            It appears after <code>nforge login</code> and lasts 10 minutes.
          </p>
        </div>
        <div className="blk">
          <form className="pad signin" onSubmit={submit} noValidate>
            <label className="f">
              Code from your terminal
              <input
                className="inp lg mono"
                name="code"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="XXXXX-XXXXX"
                value={code}
                onChange={event => setCode(formatCode(event.target.value))}
              />
            </label>
            {error}
            <Key
              kind="primary"
              size="lg"
              className="wide-btn"
              type="submit"
              disabled={phase.kind === 'checking'}
            >
              {phase.kind === 'checking' ? 'Checking…' : 'Continue'}
            </Key>
          </form>
        </div>
      </>
    );
  return <PublicFrame wide>{body}</PublicFrame>;
}
