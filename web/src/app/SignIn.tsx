// SPDX-License-Identifier: Apache-2.0
// Sign in on Convex Auth (Item de67c77d; docs/development.md "Convex Auth core beside Clerk"): one handle field that
// signs in with a passkey (or creates the account and its passkey for a new handle), and GitHub. After a GitHub
// sign-in with no passkey yet, the next page offers one (FirstPasskey). The old Clerk screens stay until removal.
//
// Lifecycle rule 2: passkey autofill runs only while this tab is visible and active (awake.tsx).
import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import { useOauth, useSignInWithGithub } from '@convex-dev/auth/methods/github/react';
import { useSignInWithUsernamePasskey } from '@convex-dev/auth/methods/username-passkey/react';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { Key, State } from '../ds';
import { WhileAwake } from './awake';
import { PublicFrame } from './frames';
import { hrefFor } from './paths';
import { useSearch } from './router';
import { errorCode, recall, remember, safeNext } from './session';
import { createPasskey, assertPasskey, type CeremonyFailure, type CreationOptions } from './webauthn';

type PasskeyHook = ReturnType<typeof useSignInWithUsernamePasskey>;
const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])$/;

const words: Record<string, string> = {
  USERNAME_HAS_INVALID_CHARACTERS:
    'Use 2–39 lowercase letters, numbers or hyphens, without a leading or trailing hyphen.',
  UNKNOWN_CREDENTIAL: 'This device has no passkey for that handle. Use a passkey from your phone, or GitHub.',
  CEREMONY_ABORTED: 'The passkey prompt closed before it finished. Nothing changed.',
  CHALLENGE_EXPIRED: 'That took longer than ten minutes. Try again.',
  WEBAUTHN_UNSUPPORTED: 'This browser cannot use passkeys here. Continue with GitHub.',
  PASSKEY_ALREADY_REGISTERED: 'This device already holds a Forge passkey. Sign in with it.',
  USERNAME_TAKEN: 'That handle is taken. If it is yours, sign in with its passkey or GitHub.',
};
const say = (code: string | undefined) =>
  (code && words[code]) ?? 'Forge could not finish signing in. Try again.';

/** Mounted only while autofill may run; renders nothing and hands the hook's state up. */
function PasskeyDriver({ onState }: { onState: (hook: PasskeyHook) => void }) {
  const hook = useSignInWithUsernamePasskey(api.auth);
  useEffect(() => onState(hook));
  return null;
}

export function SignIn() {
  const search = useSearch();
  return search.get('link') === 'existing' ? (
    <Suspense
      fallback={
        <PublicFrame>
          <div className="intro" aria-busy="true">
            <h1>Opening your existing sign-in…</h1>
          </div>
        </PublicFrame>
      }
    >
      <LegacyLink />
    </Suspense>
  ) : (
    <HandleSignIn />
  );
}
function HandleSignIn() {
  const search = useSearch();
  const next = safeNext(search.get('next'));
  const { flowError } = useOauth();
  const { signIn: github } = useSignInWithGithub(api.auth);
  const driver = useRef<PasskeyHook | null>(null);
  const [handle, setHandle] = useState('');
  const [queued, setQueued] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const run = async (username: string) => {
    const hook = driver.current;
    if (!hook) return setQueued(username);
    setQueued(null);
    setProblem(null);
    remember({ next, method: 'passkey', handle: username });
    const result = await hook.signIn({ username });
    if (result.status === 'error' && result.userError.error !== 'ALREADY_PENDING')
      setProblem(say(result.userError.error));
  };
  const onState = (hook: PasskeyHook) => {
    driver.current = hook;
    if (hook.pending !== pending) setPending(hook.pending);
    if (queued && !hook.pending) void run(queued);
  };
  useEffect(() => () => void (driver.current = null), []);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const username = handle.trim().replace(/^@/, '');
    if (!HANDLE.test(username)) return setProblem('Use 2–39 lowercase letters, numbers or hyphens.');
    void run(username);
  };
  const withGithub = async () => {
    setProblem(null);
    setLeaving(true);
    remember({ next, method: 'github' });
    try {
      await github({ redirectTo: `${location.origin}${hrefFor({ frame: 'public', page: 'signin' })}` });
    } catch (error) {
      setLeaving(false);
      setProblem(
        errorCode(error) === 'AUTH_CONFIGURATION'
          ? 'GitHub sign-in is not set up on this Forge yet. Use a passkey.'
          : say(errorCode(error)),
      );
    }
  };
  const shown = problem ?? (flowError ? say(flowError.error) : null);
  return (
    <PublicFrame>
      <WhileAwake keep={pending || !!queued}>
        <PasskeyDriver onState={onState} />
      </WhileAwake>
      <div className="intro">
        <h1>Sign in to Forge</h1>
      </div>
      <div className="blk">
        <form className="pad signin" onSubmit={submit} noValidate>
          <label className="f">
            Your handle
            <input
              className="inp lg mono"
              name="username"
              autoComplete="username webauthn"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="@handle…"
              value={handle}
              onChange={event => setHandle(event.target.value)}
              aria-invalid={shown ? true : undefined}
              aria-describedby={shown ? 'signin-problem' : undefined}
              disabled={pending}
            />
            {shown ? (
              <span className="err" id="signin-problem" role="alert">
                <State word="Check failed" state="failed">
                  {shown}
                </State>
              </span>
            ) : null}
          </label>
          <Key kind="primary" size="lg" className="wide-btn" type="submit" disabled={pending || leaving}>
            {pending || queued ? 'Waiting for your passkey…' : 'Continue'}
          </Key>
          <div className="or">or</div>
          <Key size="lg" className="wide-btn" onClick={() => void withGithub()} disabled={pending || leaving}>
            {leaving ? 'Opening GitHub…' : 'Continue with GitHub'}
          </Key>
        </form>
      </div>
      <p className="after">
        <span>New here? Type the handle you want.</span>
        <a href="/-/signin?link=existing">Add a passkey from your existing sign-in</a>
        <span>
          From a terminal: <code>nforge login</code>
        </span>
      </p>
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

/** After a first GitHub sign-in: one passkey, so the next sign-in needs no GitHub round trip. Skippable. */
export function FirstPasskey({ onDone }: { onDone: (next: string) => void }) {
  const linkedGithub = useQuery(api.authLinks.current, {});
  const passkeys = useQuery(api.auth.listPasskeys, {});
  const confirmStart = useMutation(api.authLinks.startConfirmation);
  const confirm = useMutation(api.authLinks.confirm);
  const { signIn: github } = useSignInWithGithub(api.authLinks);
  const { flowError } = useOauth();
  const start = useMutation(api.authFirstPasskey.start);
  const finish = useMutation(api.authFirstPasskey.finish);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const next = recall()?.next ?? safeNext(null);
  const add = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const made = await createPasskey((await start({})) as CreationOptions);
      if (!made.ok) return setProblem(failureWords[made.failure]);
      const result = await finish({ response: made.wire });
      if (result.success) onDone(next);
      else
        setProblem(
          result.userError.error === 'CHALLENGE_EXPIRED' ? failureWords.expired : failureWords.failed,
        );
    } catch (error) {
      setProblem(errorCode(error) === 'AUTH_EXPIRED' ? failureWords.expired : failureWords.failed);
    } finally {
      setBusy(false);
    }
  };
  const linkGithub = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const options = await confirmStart({});
      if (options) await confirm({ response: await assertPasskey(options) });
      await github({ redirectTo: new URL('/-/signin/passkey', location.origin).href });
    } catch (error) {
      setProblem(
        errorCode(error) === 'GITHUB_ACCOUNT_MISMATCH'
          ? 'That GitHub identity is linked to another Forge account.'
          : 'Forge could not link GitHub. Try again.',
      );
    } finally {
      setBusy(false);
    }
  };
  const hasPasskey = passkeys && 'passkeys' in passkeys && passkeys.passkeys.length > 0;
  return (
    <PublicFrame>
      <div className="intro">
        <h1>{hasPasskey ? 'Your sign-in methods' : 'Add a passkey'}</h1>
        <p>Next time, sign in with your fingerprint, face or device PIN. Forge stores no password.</p>
      </div>
      <div className="blk">
        <div className="pad signin">
          {problem || (flowError && !linkedGithub) ? (
            <p className="err" role="alert">
              <State word="Check failed" state="failed">
                {problem ?? 'Forge could not link GitHub. Try again.'}
              </State>
            </p>
          ) : null}
          {!hasPasskey ? (
            <Key
              kind="primary"
              size="lg"
              className="wide-btn"
              onClick={() => void add()}
              disabled={busy || passkeys === undefined}
            >
              {busy ? 'Waiting for your device…' : 'Create a passkey'}
            </Key>
          ) : (
            <p>Passkey added to this account.</p>
          )}
          {linkedGithub ? (
            <p>GitHub is linked to this account.</p>
          ) : (
            <Key size="lg" className="wide-btn" onClick={() => void linkGithub()} disabled={busy}>
              Link GitHub to this account
            </Key>
          )}
          <Key size="lg" kind="ghost" className="wide-btn" onClick={() => onDone(next)} disabled={busy}>
            Not now
          </Key>
        </div>
      </div>
    </PublicFrame>
  );
}

// The retained provider loads only for explicit existing-account linking.
const LegacyLink = lazy(() => import('./LegacyLink'));
