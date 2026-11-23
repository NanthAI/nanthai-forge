// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { useId, useState, type FormEvent } from 'react';
import { useAction } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { Key, Sheet } from '../../ds';
import { hostedError } from '../../snapshot';

/** The owner's purge of one leaked file's saved bytes (Item 9d3c407d), from that file's row on the Lane
 * page: the Lane head against its base. Same confirm pattern as Delete forever: a typed word, the way
 * out first, the destructive key last. One operation id per open sheet, so a retry from it resumes. */
export function PurgeFile({
  projectId,
  laneId,
  head,
  base,
  path,
  close,
}: {
  projectId: Id<'hostedProjects'>;
  laneId: string;
  head: string;
  base: string;
  path: string;
  close: (done?: boolean) => void;
}) {
  const purge = useAction(api.projectSavePurge.purge);
  const form = useId();
  const [operationId] = useState(() => crypto.randomUUID());
  const [typed, setTyped] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const ready = !pending && typed === 'PURGE';
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setPending(true);
    setError('');
    try {
      await purge({ projectId, laneId, head, parent: base, paths: [path], operationId, confirmation: typed });
      close(true);
    } catch (failure) {
      setError(hostedError(failure));
      setPending(false);
    }
  };
  return (
    <Sheet
      open
      title="Purge the saved bytes"
      onOpenChange={open => {
        if (!open && !pending) close();
      }}
      footer={
        <>
          <Key kind="ghost" disabled={pending} onClick={() => close()}>
            Keep the bytes
          </Key>
          <Key kind="danger" type="submit" form={form} disabled={!ready}>
            {pending ? 'Purging…' : 'Purge the bytes'}
          </Key>
        </>
      }
    >
      <form id={form} className="lr-purge" onSubmit={submit}>
        <p>
          The stored bytes of <code dir="auto">{path}</code> in this Lane are deleted for good. Every later
          read, diff, checkout or Git fetch of them says PURGED, and the Lane&apos;s thread records who purged
          it and when. Copies already downloaded stay where they are, so rotate the credential at its provider
          too.
        </p>
        <label>
          <span>Type PURGE to confirm</span>
          <input
            className="inp"
            value={typed}
            onChange={event => setTyped(event.target.value)}
            autoComplete="off"
            disabled={pending}
          />
        </label>
        {error ? (
          <p className="pf" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Sheet>
  );
}
