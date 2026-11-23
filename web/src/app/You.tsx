// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { useEffect, useRef, useState } from 'react';
import { useAuthActions } from '@convex-dev/auth/react';
import { useMutation, useQuery } from 'convex/react';
import { usePaginatedQuery } from 'convex-helpers/react';
import { useOauth, useSignInWithGithub } from '@convex-dev/auth/methods/github/react';
import { api } from '../../../convex/_generated/api';
import { PASSKEY_PAGE_SIZE } from '../../../convex/authPasskeyPage';
import { assertPasskey, createPasskey, type CreationOptions } from './webauthn';
import { errorCode } from './session';
import { DeviceProjectChoice } from './DeviceProjectChoice';
import { YouView } from './YouView';
export default function You({ handle, leave }: { handle?: string; leave?: () => void }) {
  const { signOut } = useAuthActions();
  leave ??= () => void signOut().then(() => location.assign('/signin'));
  const [cursor, setCursor] = useState<string | null>(null);
  const data = useQuery(api.authSessions.list, { paginationOpts: { numItems: 20, cursor } });
  const {
    results: morePasskeys,
    status: passkeyStatus,
    loadMore,
  } = usePaginatedQuery(
    api.authSessions.morePasskeys,
    data?.passkeysContinueAfter ? { after: data.passkeysContinueAfter } : 'skip',
    { initialNumItems: PASSKEY_PAGE_SIZE },
  );
  useEffect(() => {
    if (passkeyStatus === 'CanLoadMore') loadMore(PASSKEY_PAGE_SIZE);
  }, [passkeyStatus, loadMore]);
  const [seenNotice, setSeenNotice] = useState(() => {
    try {
      return localStorage.getItem('forge.passkey-notice') ?? '';
    } catch {
      return '';
    }
  });
  const [seenDevice, setSeenDevice] = useState(() => {
    try {
      return localStorage.getItem('forge.device-notice') ?? '';
    } catch {
      return '';
    }
  });
  const start = useMutation(api.authSessions.startConfirmation);
  const revoke = useMutation(api.authSessions.revokeOthers);
  const pendingRevoke = useRef<Parameters<typeof revoke>[0] | null>(null);
  const rename = useMutation(api.auth.renamePasskey);
  const revokeDevice = useMutation(api.deviceCredentials.revoke);
  const renameDevice = useMutation(api.deviceCredentials.rename);
  const deviceOperations = useRef(new Map<string, string>());
  const changeDevice = async (
    kind: 'configure' | 'end',
    input: {
      credentialId: string;
      name?: string;
      settings?: Parameters<typeof renameDevice>[0]['settings'];
      action?: 'remove';
    },
  ) => {
    const key = JSON.stringify({ kind, ...input });
    const operationId = deviceOperations.current.get(key) ?? crypto.randomUUID();
    deviceOperations.current.set(key, operationId);
    if (kind === 'configure')
      await renameDevice({
        credentialId: input.credentialId,
        name: input.name!,
        ...(input.settings ? { settings: input.settings } : {}),
        operationId,
      });
    else
      await revokeDevice({
        credentialId: input.credentialId,
        ...(input.action ? { action: input.action } : {}),
        operationId,
      });
    deviceOperations.current.delete(key);
  };
  // Adding or removing a passkey needs a sign-in of this browser under ten minutes old (convex/authPasskeys.ts).
  // Without one, the page asks for a GitHub or passkey check first, then finishes the change.
  const startAdd = useMutation(api.authPasskeys.start);
  const finishAdd = useMutation(api.authPasskeys.finish);
  const removePasskey = useMutation(api.authPasskeys.remove);
  const startProof = useMutation(api.authSessions.startDeviceConfirmation);
  const proveWithPasskey = useMutation(api.authSessions.confirmDeviceApproval);
  const [pendingChange, setPendingChange] = useState<(() => Promise<void>) | null>(null);
  const { signIn: github } = useSignInWithGithub(api.authSessionGithub);
  const { signIn: githubDevices } = useSignInWithGithub({
    startSignInWithGithub: api.authSessionGithub.startEndDevicesWithGithub,
    completeSignInWithGithub: api.authSessionGithub.completeSignInWithGithub,
  });
  const { signIn: githubProof } = useSignInWithGithub({
    startSignInWithGithub: api.authSessionGithub.startDeviceSignInWithGithub,
    completeSignInWithGithub: api.authSessionGithub.completeSignInWithGithub,
  });
  const { flowError } = useOauth();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch {
      setProblem('Forge could not finish that change. Try again.');
    } finally {
      setBusy(false);
    }
  };
  /** A passkey change; an expired sign-in keeps it waiting for the check the page then offers. */
  const attempt = async (work: () => Promise<void>) => {
    try {
      await work();
      setPendingChange(null);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'AUTH_EXPIRED') return setPendingChange(() => work);
      setPendingChange(null);
      if (code === 'BAD_ARGUMENT' || code === 'QUOTA_EXCEEDED')
        return setProblem(
          code === 'QUOTA_EXCEEDED'
            ? 'This account already holds the most passkeys it can. Remove one first.'
            : 'That passkey is your only way in. Add another passkey or link GitHub first.',
        );
      throw error;
    }
  };
  const change = (work: () => Promise<void>) => void run(() => attempt(work));
  const addPasskey = async () => {
    const made = await createPasskey((await startAdd({})) as CreationOptions);
    if (!made.ok) {
      if (made.failure === 'closed') return;
      if (made.failure === 'exists')
        return setProblem('This device already holds a passkey for this account.');
      throw new Error('Passkey not added');
    }
    // The browser has saved the passkey; a check that becomes due now keeps it and retries only the finish.
    const finish = async () => {
      const result = await finishAdd({ response: made.wire });
      if (!result.success) throw new Error('Passkey not added');
    };
    try {
      await finish();
    } catch (error) {
      if (errorCode(error) !== 'AUTH_EXPIRED') throw error;
      setPendingChange(() => finish);
    }
  };
  return (
    <YouView
      data={
        data
          ? {
              ...data,
              passkeys: [...data.passkeys, ...morePasskeys],
              notice: data.notice?.passkeyId === seenNotice ? null : data.notice,
              deviceNotice: data.deviceNotice?.signInId === seenDevice ? undefined : data.deviceNotice,
            }
          : undefined
      }
      handle={handle}
      now={Date.now()}
      busy={busy}
      problem={problem ?? (flowError ? 'The GitHub check did not finish. Try again.' : null)}
      leave={leave}
      more={() => data && setCursor(data.continueCursor)}
      acknowledge={() => {
        if (!data?.notice) return;
        setSeenNotice(data.notice.passkeyId);
        try {
          localStorage.setItem('forge.passkey-notice', data.notice.passkeyId);
        } catch {
          /* This visit still remembers the acknowledgement. */
        }
      }}
      acknowledgeDevice={() => {
        if (!data?.deviceNotice) return;
        setSeenDevice(data.deviceNotice.signInId);
        try {
          localStorage.setItem('forge.device-notice', data.deviceNotice.signInId);
        } catch {
          /* Kept for this visit. */
        }
      }}
      revoke={includeDevices =>
        void run(async () => {
          if (!pendingRevoke.current) {
            const options = await start({});
            pendingRevoke.current = {
              operationId: crypto.randomUUID(),
              response: await assertPasskey(options),
              ...(includeDevices ? { includeDevices: true } : {}),
            };
          }
          await revoke(pendingRevoke.current);
          pendingRevoke.current = null;
        })
      }
      github={includeDevices =>
        void run(() =>
          (includeDevices ? githubDevices : github)({
            redirectTo: new URL('/account/devices', location.origin).href,
          }),
        )
      }
      add={() => change(addPasskey)}
      remove={id => change(async () => void (await removePasskey({ passkeyId: id })))}
      proof={
        pendingChange
          ? {
              github: () =>
                void run(async () => {
                  const started = await githubProof({
                    redirectTo: new URL('/account/devices', location.origin).href,
                  });
                  if (started.status === 'error') throw new Error('GitHub check not started');
                }),
              passkey: () =>
                void run(async () => {
                  await proveWithPasskey({ response: await assertPasskey(await startProof({})) });
                  await attempt(pendingChange);
                }),
              cancel: () => setPendingChange(null),
            }
          : undefined
      }
      rename={(id, name) =>
        void run(async () => {
          const result = await rename({ passkeyId: id, name });
          if (!result.success) throw new Error('Passkey not renamed');
        })
      }
      renameDevice={(id, name) => void run(() => changeDevice('configure', { credentialId: id, name }))}
      projectChoice={select => <DeviceProjectChoice select={select} />}
      configureDevice={(id, name, settings) =>
        void run(() => changeDevice('configure', { credentialId: id, name, settings }))
      }
      removeDevice={id => void run(() => changeDevice('end', { credentialId: id, action: 'remove' }))}
      endDevice={id => void run(() => changeDevice('end', { credentialId: id }))}
    />
  );
}
