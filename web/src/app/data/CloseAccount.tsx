// SPDX-License-Identifier: Apache-2.0
// Account > Your data > Close your account (Item 17cdc774). Offered only once the account holds nothing. A press reads
// the exact before-list (accountClose.preview, one query); the close is one retry-safe mutation (accountClose.close)
// behind the typed handle, the same confirm as deleting a project forever. A retry keeps the operation id, so an
// unanswered close is asked again, never repeated. Then the person is signed out; the removal finishes on the server.
import { useRef, useState, type FormEvent } from 'react';
import type { ConvexReactClient } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import { Key, Region, Row } from '../../ds';
import { hostedError } from '../../snapshot';
import { confirmed } from './model';

export type ClosePreview = {
  handle: string;
  handles: string[];
  receipts: number;
  more: boolean;
  passkeys: number;
  devices: number;
  github: boolean;
  blocker: string | null;
  /** The running close's operation id (after a reload, or a sign-in while it ran). */
  closing: string | null;
};
export type CloseView = {
  preview: ClosePreview | null;
  busy: 'review' | 'close' | null;
  error: string;
  closed: boolean;
  onReview: () => void;
  onCancel: () => void;
  onClose: (typed: string) => void;
  /** Asks the server to carry on a close that stopped (the same operation id). */
  onContinue: () => void;
};

const count = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en')} ${n === 1 ? one : many}`;

/** State and server calls for the close step; `leave` signs the person out once the close is recorded. */
export function useCloseAccount(client: ConvexReactClient, leave: () => void): CloseView {
  const [preview, setPreview] = useState<ClosePreview | null>(null);
  const [busy, setBusy] = useState<CloseView['busy']>(null);
  const [error, setError] = useState('');
  const [closed, setClosed] = useState(false);
  // One operation per review; a retry after an error or no answer sends the same one.
  const operation = useRef<string>('');
  const run = async (kind: 'review' | 'close', work: () => Promise<void>) => {
    setBusy(kind);
    setError('');
    try {
      await work();
    } catch (failure) {
      setError(hostedError(failure));
    } finally {
      setBusy(null);
    }
  };
  return {
    preview,
    busy,
    error,
    closed,
    onReview: () =>
      void run('review', async () => {
        operation.current = crypto.randomUUID();
        setPreview(await client.query(api.accountClose.preview, {}));
      }),
    onCancel: () => {
      setPreview(null);
      setError('');
    },
    onClose: typed =>
      void run('close', async () => {
        await client.mutation(api.accountClose.close, { operationId: operation.current, handle: typed });
        setClosed(true);
        leave();
      }),
    onContinue: () =>
      void run('close', async () => {
        if (!preview?.closing) return;
        await client.mutation(api.accountClose.close, {
          operationId: preview.closing,
          handle: preview.handle,
        });
        setClosed(true);
        leave();
      }),
  };
}

/** The close step, shown only when the account holds nothing. */
export function CloseRegion({ handle, ...view }: CloseView & { handle: string | undefined }) {
  const { preview, busy, closed } = view;
  const [typed, setTyped] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const word = preview?.handle ?? handle ?? '';
  const ok = !!word && confirmed(typed, word);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ok) return input.current?.focus();
    // The canonical handle: the typed text matched it (letter case aside), and the server checks it exactly.
    view.onClose(word);
  };
  return (
    <Region title="Close your account" weight="ref">
      {closed ? (
        <div className="pf">
          <p role="status">Forge is closing your account. You are being signed out.</p>
        </div>
      ) : preview?.closing ? (
        <div className="pf">
          <p role="status">
            Closing this account started and has not finished. Continue it; nothing is removed twice.
          </p>
          <div className="btns">
            <Key kind="danger" disabled={!!busy} onClick={view.onContinue}>
              {busy === 'close' ? 'Closing…' : 'Continue closing'}
            </Key>
          </div>
        </div>
      ) : !preview ? (
        <div className="pf">
          <p>Forge holds nothing else for you. Closing removes your account and frees your handle.</p>
          <div className="btns">
            <Key disabled={!!busy} onClick={view.onReview}>
              {busy === 'review' ? 'Reading…' : 'Review closing your account'}
            </Key>
          </div>
        </div>
      ) : preview.blocker ? (
        <div className="pf">
          <p role="alert">{preview.blocker}</p>
          <div className="btns">
            <Key disabled={!!busy} onClick={view.onCancel}>
              Back
            </Key>
          </div>
        </div>
      ) : (
        <>
          <div className="group">
            <Row cols="minmax(0, 1fr) auto">
              <span className="nm">
                <b>Your account</b>
                <span className="meta" translate="no">
                  {preview.handles.join(', ')}
                </span>
              </span>
              <span className="r cnt">{count(preview.handles.length, 'handle')} freed</span>
            </Row>
            <Row cols="minmax(0, 1fr) auto">
              <span className="nm">
                <b>Deletion receipts</b>
              </span>
              <span className="r cnt">
                {preview.more ? 'At least ' : ''}
                {count(preview.receipts, 'receipt')}
              </span>
            </Row>
            <Row cols="minmax(0, 1fr) auto">
              <span className="nm">
                <b>Sign-in</b>
                <span className="meta">Every browser and device is signed out.</span>
              </span>
              <span className="r cnt">
                {count(preview.passkeys, 'passkey')}, {count(preview.devices, 'device')}
              </span>
            </Row>
          </div>
          <div className="pf">
            <p>
              Records of projects you already deleted stay, without your handle.
              {preview.github ? ' Signing in with GitHub again later starts a new, empty account.' : ''}
            </p>
          </div>
          <form className="confirm" onSubmit={submit} noValidate>
            <p className="meta">
              <strong>This cannot be undone.</strong>
            </p>
            <label htmlFor="close-confirm">Type your handle, {word}, to close your account</label>
            <input
              id="close-confirm"
              ref={input}
              className="inp mono"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={typed}
              onChange={event => setTyped(event.target.value)}
              disabled={busy === 'close'}
            />
            <div className="btns">
              <Key type="submit" kind="danger" disabled={!!busy || !ok}>
                {busy === 'close' ? 'Closing…' : 'Close my account'}
              </Key>
              <Key disabled={busy === 'close'} onClick={view.onCancel}>
                Keep my account
              </Key>
            </div>
          </form>
        </>
      )}
      {view.error ? (
        <p className="err" role="alert">
          {view.error}
        </p>
      ) : null}
    </Region>
  );
}
