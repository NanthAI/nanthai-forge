// SPDX-License-Identifier: Apache-2.0
import { useEffect, useId, useRef, useState } from 'react';
import { useConvex, useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { hostedError } from './snapshot';
import { ErrorToast } from './ui/Toast';

type Confirmation = {
  principal: string;
  busy: boolean;
  close: () => void;
  confirm: (policyRevision: number) => Promise<void>;
};
export function SecretRevokeContents({
  principal,
  busy,
  close,
  confirm,
  preview,
  names,
  titleId,
}: Confirmation & {
  preview: FunctionReturnType<typeof api.secrets.revocationPreview> | undefined;
  names: Record<string, string>;
  titleId: string;
}) {
  return (
    <>
      <header className="detail-panel-heading">
        <h2 id={titleId}>Revoke access for {names[principal] ?? principal}?</h2>
      </header>
      <div className="panel-content">
        {preview ? (
          <>
            <p>
              This also removes {preview.grants.length} grants made by {names[principal] ?? principal}.
            </p>
            <ul>
              {preview.grants.map(row => (
                <li key={row.principal}>
                  {names[row.principal] ?? row.principal} · {row.capabilities.join(', ')}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p role="status">Loading affected grants…</p>
        )}
        <button type="button" disabled={busy} onClick={close}>
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || !preview}
          onClick={() => preview && void confirm(preview.policyRevision)}
        >
          {busy ? 'Revoking…' : 'Revoke access'}
        </button>
      </div>
    </>
  );
}
export default function SecretRevokeConfirmation({
  id,
  ...props
}: Confirmation & { id: Id<'secretObjects'> }) {
  const { principal, busy, close } = props;
  const client = useConvex(),
    dialog = useRef<HTMLDialogElement>(null),
    titleId = useId(),
    preview = useQuery(api.secrets.revocationPreview, { id, principal }),
    [names, setNames] = useState<Record<string, string>>({}),
    [error, setError] = useState('');
  useEffect(() => {
    const element = dialog.current,
      previous = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    let active = true;
    void client
      .action(api.secretActions.revocationNames, { id, principal })
      .then(rows => {
        if (active) {
          setNames(Object.fromEntries(rows.map(row => [row.principal, row.name])));
          setError('');
        }
      })
      .catch(e => {
        if (active) setError(hostedError(e));
      });
    return () => {
      active = false;
    };
  }, [client, id, principal, preview?.policyRevision]);
  return (
    <dialog
      className="detail-panel"
      ref={dialog}
      onCancel={event => {
        event.preventDefault();
        if (!busy) close();
      }}
      aria-labelledby={titleId}
    >
      <SecretRevokeContents {...props} preview={preview} names={names} titleId={titleId} />
      {error && <ErrorToast>{error}</ErrorToast>}
    </dialog>
  );
}
