// SPDX-License-Identifier: Apache-2.0
// Approve or deny an `nforge login` from the browser, signed in with Convex Auth. The same backend as the old /device
// page (convex/deviceActions.ts): one inspect when the code is complete, one decide per answer. A decision keeps its
// operation id until it succeeds, so a retry after a lost reply never records two decisions. The full device and
// session screens are stage C (Item df06081d); this page is the approval step the CLI links to.
// It keeps every rule of the old page (docs/security.md, "CLI device credentials"): server-known facts first and the
// terminal-chosen name last, quoted, cleaned and marked not verified; a code from a link leaves the address on arrival,
// is never shown and must be typed again before Approve; a decided or lapsed code offers no answer. No timers: expiry
// is read when the card renders and again before an answer.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useAction } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { Key, State } from '../ds';
import { codeComplete, codeProblem, expiresIn, formatCode, scopeWords } from '../device/code';
import { UntrustedName } from '../device/DeviceName';
import { forgetLinkCode, takeLinkCode } from '../device/link-code';
import { PublicFrame } from './frames';
import { hrefFor } from './paths';
import { errorCode } from './session';

export type DeviceRequest = { name: string; scope: 'cli' | 'coordination'; expiresAt: number; state: string };
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
  if (state === 'denied') return 'This code was denied. Run nforge login again for a new one.';
  return 'This code already has a decision.';
}

export function Device({ viewerHandle }: { viewerHandle: string | undefined }) {
  const inspect = useAction(api.deviceActions.inspect);
  const decideAction = useAction(api.deviceActions.decide);
  const [code, setCode] = useState(takeLinkCode);
  const [phase, setPhase] = useState<DevicePhase>({ kind: 'enter' });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const decision = useRef<{ operationId: string; approve: boolean } | null>(null);
  const checked = useRef(false);
  // A code that arrived in a link must be typed again before Approve unlocks: a link alone never approves a device.
  const fromLink = useRef(codeComplete(code));
  const [typed, setTyped] = useState('');
  const fail = (error: unknown, back: DevicePhase) => {
    const known = codeProblem(errorCode(error));
    if (known) {
      forgetLinkCode();
      return setPhase({ kind: 'problem', problem: known });
    }
    // Back to the code field: a code from a link is typed from the terminal, never shown prefilled.
    if (back.kind === 'enter' && fromLink.current) {
      fromLink.current = false;
      forgetLinkCode();
      setCode('');
    }
    setPhase(back);
    setProblem(
      errorCode(error) === 'AUTH_SLOW_DOWN'
        ? 'Too many tries. Wait a minute.'
        : 'Forge could not check that code. Try again.',
    );
  };
  const find = async () => {
    setPhase({ kind: 'checking' });
    setProblem(null);
    try {
      decision.current = null;
      setPhase({ kind: 'review', request: (await inspect({ code })) as DeviceRequest });
    } catch (error) {
      fail(error, { kind: 'enter' });
    }
  };
  useEffect(() => {
    if (checked.current || !codeComplete(code)) return;
    checked.current = true;
    void find();
    // A code from the link is checked once, on arrival.
  }, []);
  const decide = async (approve: boolean) => {
    if (phase.kind !== 'review') return;
    if (phase.request.expiresAt <= Date.now()) {
      forgetLinkCode();
      return setPhase({ kind: 'problem', problem: 'expired' });
    }
    if (decision.current?.approve !== approve)
      decision.current = { operationId: crypto.randomUUID(), approve };
    setBusy(true);
    setProblem(null);
    try {
      await decideAction({ code, ...decision.current });
      forgetLinkCode();
      setPhase({ kind: 'done', approved: approve, name: phase.request.name });
    } catch (error) {
      fail(error, phase);
    } finally {
      setBusy(false);
    }
  };
  const restart = () => {
    decision.current = null;
    fromLink.current = false;
    forgetLinkCode();
    setCode('');
    setTyped('');
    setProblem(null);
    setPhase({ kind: 'enter' });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (codeComplete(code)) void find();
    else setProblem('The code has ten letters and digits, as XXXXX-XXXXX.');
  };
  return (
    <DeviceView
      phase={phase}
      code={code}
      setCode={setCode}
      typed={typed}
      setTyped={setTyped}
      requireTyped={fromLink.current}
      busy={busy}
      problem={problem}
      viewerHandle={viewerHandle}
      now={Date.now()}
      submit={submit}
      decide={approve => void decide(approve)}
      restart={restart}
    />
  );
}

/** The /-/device page itself. Pure: the container supplies the phase, the code and the actions. */
export function DeviceView({
  phase,
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
}: {
  phase: DevicePhase;
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
          <h1>Approve this device?</h1>
          <p>
            Approve only if you just ran <code>nforge login</code> yourself. If you did not, deny it.
          </p>
        </div>
        <div className="blk">
          {/* Facts the server knows come first; the name the terminal chose comes last. */}
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
                {error}
                <Key
                  kind="primary"
                  size="lg"
                  className="wide-btn"
                  onClick={() => decide(true)}
                  disabled={busy || (requireTyped && formatCode(typed) !== formatCode(code))}
                >
                  Approve
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
