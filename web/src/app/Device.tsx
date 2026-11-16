// SPDX-License-Identifier: Apache-2.0
// Approve or deny an `nforge login` from the browser, signed in with Convex Auth. The same backend as the old /device
// page (convex/deviceActions.ts): one inspect when the code is complete, one decide per answer. A decision keeps its
// operation id until it succeeds, so a retry after a lost reply never records two decisions. The full device and
// session screens are stage C (Item df06081d); this page is the approval step the CLI links to.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useAction } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { Key, State } from '../ds';
import { codeComplete, codeProblem, expiresIn, formatCode, scopeWords } from '../device/code';
import { PublicFrame } from './frames';
import { hrefFor } from './paths';
import { errorCode } from './session';

type Request = { name: string; scope: 'cli' | 'coordination'; expiresAt: number; state: string };
type Phase =
  | { kind: 'enter' }
  | { kind: 'checking' }
  | { kind: 'review'; request: Request }
  | { kind: 'done'; approved: boolean; name: string }
  | { kind: 'problem'; problem: 'expired' | 'used' };

export function Device({ viewerHandle }: { viewerHandle: string | undefined }) {
  const inspect = useAction(api.deviceActions.inspect);
  const decideAction = useAction(api.deviceActions.decide);
  const [code, setCode] = useState(() => formatCode(new URLSearchParams(location.search).get('code') ?? ''));
  const [phase, setPhase] = useState<Phase>({ kind: 'enter' });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const decision = useRef<{ operationId: string; approve: boolean } | null>(null);
  const checked = useRef(false);
  // A code that arrived in a link must be typed again before Approve unlocks: a link alone never approves a device.
  const fromLink = useRef(codeComplete(code));
  const [typed, setTyped] = useState('');
  const fail = (error: unknown, back: Phase) => {
    const known = codeProblem(errorCode(error));
    if (known) return setPhase({ kind: 'problem', problem: known });
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
      setPhase({ kind: 'review', request: (await inspect({ code })) as Request });
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
    if (decision.current?.approve !== approve)
      decision.current = { operationId: crypto.randomUUID(), approve };
    setBusy(true);
    setProblem(null);
    try {
      await decideAction({ code, ...decision.current });
      setPhase({ kind: 'done', approved: approve, name: phase.request.name });
    } catch (error) {
      fail(error, phase);
    } finally {
      setBusy(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (codeComplete(code)) void find();
    else setProblem('The code has ten letters and digits, as XXXXX-XXXXX.');
  };
  const error = problem ? (
    <p className="err" role="alert">
      <State word="Check failed" state="failed">
        {problem}
      </State>
    </p>
  ) : null;
  let body;
  if (phase.kind === 'review') {
    const { request } = phase;
    body = (
      <>
        <div className="intro">
          <h1>Approve this device?</h1>
          <p>
            Approve only if you just ran <code>nforge login</code> yourself. If you did not, deny it.
          </p>
        </div>
        <div className="blk">
          <dl className="pad facts">
            <dt>Device</dt>
            <dd className="cut" translate="no">
              {request.name}
            </dd>
            <dt>Acts for</dt>
            <dd>{viewerHandle ? `@${viewerHandle}` : 'You'}</dd>
            <dt>Access</dt>
            <dd>{scopeWords(request.scope)}</dd>
            <dt>Code expires</dt>
            <dd>{expiresIn(request.expiresAt, Date.now())}</dd>
          </dl>
          <div className="pad signin">
            {fromLink.current ? (
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
              onClick={() => void decide(true)}
              disabled={busy || (fromLink.current && typed !== code)}
            >
              Approve
            </Key>
            <Key size="lg" className="wide-btn" onClick={() => void decide(false)} disabled={busy}>
              Deny
            </Key>
          </div>
        </div>
      </>
    );
  } else if (phase.kind === 'done')
    body = (
      <div className="intro">
        <h1>{phase.approved ? `“${phase.name}” is signed in` : 'Denied'}</h1>
        <p>
          {phase.approved
            ? 'Return to the terminal. It continues on its own.'
            : 'The terminal was told. No device was added and nothing was signed in.'}
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
      <div className="intro">
        <h1>{phase.problem === 'expired' ? 'This code has expired' : 'This code was already answered'}</h1>
        <p>
          {phase.problem === 'expired'
            ? 'Codes last 10 minutes. Run nforge login again for a new one.'
            : 'Return to the terminal; it already has its answer.'}
        </p>
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
