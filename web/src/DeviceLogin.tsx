// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState } from 'react';
import { SignInButton, useUser } from '@clerk/react';
import { useConvex, useConvexAuth } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { Button } from './ui/primitives';
import { Shell } from './shell/Shell';
import { useNow } from './shell/StatusBar';
import { hostedError } from './snapshot';
import { codeComplete, codeProblem, formatCode } from './device/code';
import { DeviceApproval, type DevicePhase } from './device/DeviceApproval';
export { DeviceCredentials } from './device/DeviceList';

/**
 * /device: approve or deny a terminal sign-in. The code comes from ?code= and is checked as soon as
 * the viewer is signed in. A decision keeps its operation id until it succeeds, so a retry after a
 * network error never records two decisions.
 */
export default function DeviceLogin() {
  const { user } = useUser();
  const { isAuthenticated, isLoading } = useConvexAuth(),
    client = useConvex(),
    now = useNow(5_000);
  const [code, setCode] = useState(() => formatCode(new URLSearchParams(location.search).get('code') ?? ''));
  const [phase, setPhase] = useState<DevicePhase>({ kind: 'enter' });
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const decision = useRef<{ operationId: string; approve: boolean } | null>(null);
  const checked = useRef(false);

  const fail = (e: unknown, fallback: DevicePhase) => {
    const message = hostedError(e);
    const problem = codeProblem(message);
    if (problem) {
      setPhase({ kind: 'problem', problem });
      setError('');
    } else {
      setPhase(fallback);
      setError(message);
    }
  };
  const find = useCallback(async () => {
    setPhase({ kind: 'checking' });
    setError('');
    try {
      const request = await client.action(api.deviceActions.inspect, { code });
      decision.current = null;
      setPhase(
        request.state === 'pending' ? { kind: 'review', request } : { kind: 'problem', problem: 'used' },
      );
    } catch (e) {
      fail(e, { kind: 'enter' });
    }
  }, [client, code]);
  useEffect(() => {
    if (isAuthenticated && !checked.current && codeComplete(code)) {
      checked.current = true;
      void find();
    }
  }, [isAuthenticated, code, find]);

  const decide = async (approve: boolean) => {
    if (phase.kind !== 'review') return;
    const name = phase.request.name;
    // Reuse the id of an unfinished attempt with the same answer.
    if (!decision.current || decision.current.approve !== approve)
      decision.current = { operationId: crypto.randomUUID(), approve };
    setBusy(true);
    setError('');
    try {
      if (approve)
        await client.mutation(api.urlAccounts.ensure, {
          ...(user?.username ? { username: user.username } : {}),
          ...(user?.firstName ? { firstName: user.firstName } : {}),
          ...(user?.lastName ? { lastName: user.lastName } : {}),
        });
      await client.action(api.deviceActions.decide, { code, ...decision.current });
      setPhase(approve ? { kind: 'approved', name } : { kind: 'denied', name });
    } catch (e) {
      fail(e, phase);
    } finally {
      setBusy(false);
    }
  };
  const restart = () => {
    decision.current = null;
    setCode('');
    setError('');
    setPhase({ kind: 'enter' });
    history.replaceState(null, '', '/device');
  };
  const shown: DevicePhase = isLoading
    ? { kind: 'loading' }
    : !isAuthenticated
      ? { kind: 'signed-out' }
      : phase;
  return (
    <Shell tabs={[]} current="" onTab={() => undefined} label="Forge">
      <DeviceApproval
        phase={shown}
        code={code}
        setCode={setCode}
        find={() => void find()}
        decide={approve => void decide(approve)}
        restart={restart}
        busy={busy}
        error={error}
        now={now}
        signIn={
          <SignInButton mode="modal">
            <Button variant="primary" size="lg">
              Sign in to approve
            </Button>
          </SignInButton>
        }
      />
    </Shell>
  );
}
