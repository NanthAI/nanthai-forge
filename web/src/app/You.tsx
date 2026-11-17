// SPDX-License-Identifier: Apache-2.0
import { useRef, useState } from 'react';
import { useAuthActions } from '@convex-dev/auth/react';
import { useMutation, useQuery } from 'convex/react';
import { useOauth, useSignInWithGithub } from '@convex-dev/auth/methods/github/react';
import { useAddPasskey, useRemovePasskey } from '@convex-dev/auth/methods/username-passkey/react';
import { api } from '../../../convex/_generated/api';
import { assertPasskey } from './webauthn';
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
  const start = useMutation(api.authSessions.startConfirmation);
  const revoke = useMutation(api.authSessions.revokeOthers);
  const pendingRevoke = useRef<Parameters<typeof revoke>[0] | null>(null);
  const rename = useMutation(api.auth.renamePasskey);
  const revokeDevice = useMutation(api.deviceCredentials.revoke);
  const renameDevice = useMutation(api.deviceCredentials.rename);
  const { addPasskey, pending: adding } = useAddPasskey(api.auth);
  const { removePasskey, pending: removing } = useRemovePasskey(api.auth);
  const { signIn: github } = useSignInWithGithub(api.authSessionGithub);
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
        data ? { ...data, notice: data.notice?.passkeyId === seenNotice ? null : data.notice } : undefined
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
      revoke={() =>
        void run(async () => {
          if (!pendingRevoke.current) {
            const options = await start({});
            pendingRevoke.current = {
              operationId: crypto.randomUUID(),
              response: await assertPasskey(options),
            };
          }
          await revoke(pendingRevoke.current);
          pendingRevoke.current = null;
        })
      }
      github={() =>
        void run(() => github({ redirectTo: new URL('/-/account/devices', location.origin).href }))
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
      renameDevice={(id, name) =>
        void run(() => renameDevice({ credentialId: id, name, operationId: crypto.randomUUID() }))
      }
      endDevice={id => void run(() => revokeDevice({ credentialId: id, operationId: crypto.randomUUID() }))}
    />
  );
}
