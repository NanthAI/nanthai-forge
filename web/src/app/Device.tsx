// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Approve or deny an `nforge login` from the browser, signed in with Convex Auth. The backend is convex/deviceActions.ts: one inspect when the code is complete, one decide per answer. A decision keeps its
// operation id until it succeeds, so a retry after a lost reply never records two decisions. The full device and
// session screens are stage C (Item df06081d); this page is the approval step the CLI links to.
// It keeps every rule of the earlier /device page (docs/security.md, "CLI device credentials"): server-known facts first and the
// terminal-chosen name last, quoted, cleaned and marked not verified; a code from a link leaves the address on arrival,
// is never shown and must be typed again before Approve; a decided or lapsed code offers no answer. No timers: expiry
// is read when the card renders and again before an answer.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSignInWithGithub } from '@convex-dev/auth/methods/github/react';
import { assertPasskey } from './webauthn';
import { useAction, useMutation } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import type { DeviceSettings as Settings } from './access-contract';
import { approvedDevice, codeComplete, codeProblem, draftFor, passkeyRecheck } from '../device/code';
import { forgetLinkCode, githubReturn, takeLinkCode, takeTypedCode } from '../device/link-code';
import { DeviceView, type DevicePhase } from './DeviceView';
export { DeviceView } from './DeviceView';
export type { DeviceRequest, DevicePhase } from './DeviceView';
import { errorCode } from './session';

export function Device({ viewerHandle }: { viewerHandle: string | undefined }) {
  const startConfirmation = useMutation(api.authSessions.startDeviceConfirmation);
  const confirm = useMutation(api.authSessions.confirmDeviceApproval);
  const { signIn: github } = useSignInWithGithub({
    startSignInWithGithub: api.authSessionGithub.startDeviceSignInWithGithub,
    completeSignInWithGithub: api.authSessionGithub.completeSignInWithGithub,
  });
  const inspect = useAction(api.deviceActions.inspect);
  const decideAction = useAction(api.deviceActions.decide);
  const [code, setCode] = useState(takeLinkCode);
  const [requestId, setRequestId] = useState(() => new URL(location.href).searchParams.get('request') ?? '');
  const [name, setName] = useState('');
  const [settings, setSettings] = useState<Settings | undefined>();
  const [phase, setPhase] = useState<DevicePhase>({ kind: 'enter' });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const decision = useRef<{ operationId: string; approve: boolean } | null>(null);
  const checked = useRef(false);
  // A code that arrived in a link must be typed again before Approve unlocks: a link alone never approves a device.
  const fromLink = useRef(codeComplete(code));
  // A GitHub check returns here: the code typed before it comes back typed.
  const [typed, setTyped] = useState(() => takeTypedCode({ requestId, code }));
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
  type Draft = { name: string; settings: Settings | undefined };
  const find = async (kept?: Draft): Promise<Draft> => {
    setPhase({ kind: 'checking' });
    setProblem(null);
    try {
      decision.current = null;
      const request = await inspect(requestId ? { requestId } : { code });
      if ('needsCode' in request) {
        setRequestId('');
        fromLink.current = false;
        setCode('');
        setPhase({ kind: 'enter' });
        return kept ?? { name, settings };
      }
      const draft = draftFor(request, kept);
      setName(draft.name);
      setSettings(draft.settings);
      setPhase({ kind: 'review', request });
      return draft;
    } catch (error) {
      fail(error, { kind: 'enter' });
      return kept ?? { name, settings };
    }
  };
  useEffect(() => {
    if (checked.current || (!requestId && !codeComplete(code))) return;
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
      await decideAction({
        ...(requestId ? { requestId } : {}),
        ...(approve && (fromLink.current || requestId) ? { code: typed } : code ? { code } : {}),
        ...decision.current,
        ...approvedDevice(phase.request.device, { name, settings }),
      });
      forgetLinkCode();
      setPhase({
        kind: 'done',
        approved: approve,
        name: phase.request.device && !phase.request.device.known ? name : phase.request.name,
      });
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
    setRequestId('');
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
      confirmPasskey={() =>
        void (async () => {
          const back = phase;
          setBusy(true);
          try {
            await passkeyRecheck(
              async () =>
                void (await confirm({ response: await assertPasskey(await startConfirmation({})) })),
              find,
              { name, settings },
            );
          } catch (error) {
            fail(error, back);
          } finally {
            setBusy(false);
          }
        })()
      }
      confirmGithub={() =>
        void github({
          redirectTo: githubReturn({ code, typed, fromLink: fromLink.current, requestId }),
        }).catch(error => fail(error, phase))
      }
      phase={phase}
      name={name}
      setName={setName}
      settings={settings}
      setSettings={setSettings}
      code={code}
      setCode={setCode}
      typed={typed}
      setTyped={setTyped}
      requireTyped={fromLink.current || Boolean(requestId)}
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
