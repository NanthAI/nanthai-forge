// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { useRef, useState } from 'react';
import { Key } from '../../ds';
import type { FullItem } from './batch';
import type { Put } from './Plan';

/** Read the pin from the detail already loaded, not from the public or compact Plan list. */
export function FollowWork({ item, put }: { item: FullItem; put?: Put | undefined }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const operation = useRef<string | undefined>(undefined);
  if (!item.statusPin) return null;
  const { by, at } = item.statusPin;
  const clear = async () => {
    if (!put || pending) return;
    operation.current ??= crypto.randomUUID();
    setPending(true);
    setError('');
    try {
      await put({ itemId: item.id, expectedVersion: item.version, statusPin: null }, operation.current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not follow work. Try again.');
    } finally {
      setPending(false);
    }
  };
  return (
    <div>
      <span className="t3">
        Pinned by {by} on <time dateTime={at}>{at.slice(0, 10)}</time>
      </span>
      {put ? (
        <Key size="sm" disabled={pending} onClick={() => void clear()}>
          Follow work
        </Key>
      ) : null}
      {error ? (
        <div role="alert" className="pf">
          {error}
        </div>
      ) : null}
    </div>
  );
}
