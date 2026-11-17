// SPDX-License-Identifier: Apache-2.0
import { useRef, useState } from 'react';
import { useAuthActions } from '@convex-dev/auth/react';
import { useMutation, useQuery } from 'convex/react';
import { useOauth, useSignInWithGithub } from '@convex-dev/auth/methods/github/react';
import { useAddPasskey, useRemovePasskey } from '@convex-dev/auth/methods/username-passkey/react';
import { api } from '../../../convex/_generated/api';
import { assertPasskey } from './webauthn';
import { DeviceProjectChoice } from './DeviceProjectChoice';
import { YouView } from './YouView';
export default function You({ handle, leave }: { handle?: string; leave?: () => void }) {
  const { signOut } = useAuthActions();
  leave ??= () => void signOut().then(() => location.assign('/-/signin'));
  const [cursor, setCursor] = useState<string | null>(null);
  const data = useQuery(api.authSessions.list, { paginationOpts: { numItems: 20, cursor } });
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
  const { addPasskey, pending: adding } = useAddPasskey(api.auth);
  const { removePasskey, pending: removing } = useRemovePasskey(api.auth);
  const { signIn: github } = useSignInWithGithub(api.authSessionGithub);
  const { signIn: githubDevices } = useSignInWithGithub({
    startSignInWithGithub: api.authSessionGithub.startEndDevicesWithGithub,
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
  return (
    <YouView
      data={
        data
          ? {
              ...data,
              notice: data.notice?.passkeyId === seenNotice ? null : data.notice,
              deviceNotice: data.deviceNotice?.signInId === seenDevice ? undefined : data.deviceNotice,
            }
          : undefined
      }
      handle={handle}
      now={Date.now()}
      busy={busy || adding || removing}
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
            redirectTo: new URL('/-/account/devices', location.origin).href,
          }),
        )
      }
      add={() =>
        void run(async () => {
          const result = await addPasskey();
          if (!result.success) throw new Error('Passkey not added');
        })
      }
      remove={id =>
        void run(async () => {
          const result = await removePasskey(id);
          if (!result.success) throw new Error('Passkey not removed');
        })
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
