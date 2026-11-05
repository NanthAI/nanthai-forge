// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { Sheet } from '../ui/Sheet';
import { Button } from '../ui/primitives';
import { ErrorToast } from '../ui/Toast';
import { hostedError } from '../snapshot';
import { HandleForm } from '../settings/AccountHandle';

const dismissedKey = 'forge.handle-prompt-dismissed';
function dismissedThisSession() {
  try {
    return sessionStorage.getItem(dismissedKey) === '1';
  } catch {
    return false;
  }
}

/** Asks once for a handle when the account has none it chose: no username or GitHub login, or an
 * older handle derived from a real name. Picking or keeping one answers it for good; closing hides
 * it for this browser session. It shares the shell's account subscription, so no call is added. */
export function HandlePrompt() {
  const account = useQuery(api.urlAccounts.current, {});
  const keep = useMutation(api.urlAccounts.set);
  const [dismissed, setDismissed] = useState(dismissedThisSession);
  const [operationId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!account?.pick || dismissed) return null;
  const close = () => {
    try {
      sessionStorage.setItem(dismissedKey, '1');
    } catch {
      /* Hidden for this page view only. */
    }
    setDismissed(true);
  };
  return (
    <Sheet title="Pick your handle" onClose={close} compact width={480}>
      <p>Collaborators and agents see you by this handle. You can change it later in settings.</p>
      <HandleForm initial={account.handle} />
      <Button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError('');
          void keep({ handle: account.handle, operationId })
            .catch(e => setError(hostedError(e)))
            .finally(() => setBusy(false));
        }}
      >
        Keep @{account.handle}
      </Button>
      {error && <ErrorToast>{error}</ErrorToast>}
    </Sheet>
  );
}
