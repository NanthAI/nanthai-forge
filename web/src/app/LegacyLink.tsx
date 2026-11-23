// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import * as Clerk from '@clerk/react';
import { useRef, useState } from 'react';
import { api } from '../../../convex/_generated/api';
import { Key, State } from '../ds';
import { PublicFrame } from './frames';
import { signInHref } from './paths';
import { useSearch } from './router';
import { errorCode, safeNext } from './session';
import { assertPasskey, createPasskey, type CreationOptions, type CeremonyFailure } from './webauthn';

export default function LegacyLink() {
  const key = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;
  return key ? (
    <Clerk.ClerkProvider publishableKey={key}>
      <LegacyForm />
    </Clerk.ClerkProvider>
  ) : (
    <PublicFrame>
      <div className="intro">
        <h1>Existing sign-in is not configured</h1>
      </div>
    </PublicFrame>
  );
}
const failureWords: Record<CeremonyFailure | 'expired', string> = {
  unsupported: 'This browser cannot make a passkey. You can add one later in Sign-in and devices.',
  closed: 'The passkey prompt closed before it finished. Nothing changed.',
  exists: 'This device already holds a Forge passkey.',
  failed: 'Forge could not add the passkey. Try again.',
  expired: 'Too long since you signed in. You can add a passkey in Sign-in and devices.',
};

function LegacyForm() {
  // Back on the sign-in page, a passkey sign-in returns where it started, such as /device.
  const back = signInHref(safeNext(useSearch().get('next')));
  const { isLoaded, isSignedIn, sessionId, getToken } = Clerk.useAuth();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const pending = useRef<{ operationId: string; response: import('./webauthn').RegistrationWire } | null>(
    null,
  );
  const add = async () => {
    if (!sessionId) return;
    setBusy(true);
    setProblem(null);
    const { ConvexHttpClient } = await import('convex/browser');
    const client = new ConvexHttpClient(import.meta.env.VITE_CONVEX_URL as string);
    const authenticate = async () => {
      const token = await getToken({ template: 'convex', skipCache: true });
      if (!token) throw new Error('Sign in to your existing account.');
      client.setAuth(token);
    };
    try {
      await authenticate();
      if (!pending.current) {
        const operationId = crypto.randomUUID();
        const started = await client.action(api.authLegacy.start, { sessionId, operationId });
        let options: CreationOptions;
        if (started.step === 'authenticate') {
          const response = await assertPasskey(started.options);
          await authenticate();
          options = await client.action(api.authLegacy.confirm, { sessionId, operationId, response });
        } else options = started.options;
        const made = await createPasskey(options);
        if (!made.ok) {
          setProblem(failureWords[made.failure]);
          return;
        }
        pending.current = { operationId, response: made.wire };
      }
      await authenticate();
      const result = await client.action(api.authLegacy.finish, { sessionId, ...pending.current });
      if (result.success) {
        pending.current = null;
        setDone(true);
      } else {
        pending.current = null;
        setProblem(failureWords.failed);
      }
    } catch (error) {
      setProblem(
        errorCode(error) === 'AUTH_REQUIRED'
          ? 'Sign in to your existing account, then try again.'
          : 'Forge could not add the passkey. Try again.',
      );
    } finally {
      client.clearAuth();
      setBusy(false);
    }
  };
  return (
    <PublicFrame>
      <div className="intro">
        <h1>{done ? 'Your account has a passkey' : 'Keep your existing Forge account'}</h1>
        <p>
          Add a passkey while signed in with your existing method. Then sign in with it to link GitHub in
          Sign-in and devices.
        </p>
      </div>
      <div className="blk">
        <div className="pad signin">
          {problem ? (
            <p className="err" role="alert">
              <State word="Check failed" state="failed">
                {problem}
              </State>
            </p>
          ) : null}
          {!isLoaded ? (
            <p aria-busy="true">Opening your existing sign-in…</p>
          ) : !isSignedIn ? (
            <Clerk.SignInButton mode="modal">
              <Key kind="primary" size="lg" className="wide-btn">
                Continue with your existing sign-in
              </Key>
            </Clerk.SignInButton>
          ) : done ? (
            <Key kind="primary" size="lg" className="wide-btn" onClick={() => location.assign(back)}>
              Continue with your passkey
            </Key>
          ) : (
            <Key kind="primary" size="lg" className="wide-btn" disabled={busy} onClick={() => void add()}>
              {busy ? 'Waiting for your device…' : 'Add a passkey to this account'}
            </Key>
          )}
          <Key
            size="lg"
            kind="ghost"
            className="wide-btn"
            disabled={busy}
            onClick={() => location.assign(back)}
          >
            Back to sign-in
          </Key>
        </div>
      </div>
    </PublicFrame>
  );
}
