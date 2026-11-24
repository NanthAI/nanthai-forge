// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { useEffect, useState } from 'react';
import { Key } from '../../ds';

/** Copies one constructed, value-free command; the person runs it on a terminal. The label says Copied for two
 * seconds. A failed clipboard never echoes the browser's exception. */
export function SecretCommand({
  command,
  label,
  size = 'sm',
  kind,
}: {
  command: string;
  /** The key's words before it is pressed ("Copy command", "Copy apply"). */
  label: string;
  size?: 'sm';
  kind?: 'ghost';
}) {
  const [result, setResult] = useState<'copied' | 'failed' | null>(null);
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setResult(null), 2000);
    return () => clearTimeout(timer);
  }, [result]);
  return (
    <>
      <Key
        size={size}
        kind={kind}
        title={command}
        onClick={() => {
          void (async () => {
            try {
              await navigator.clipboard.writeText(command);
              setResult('copied');
            } catch {
              setResult('failed');
            }
          })();
        }}
      >
        {result === 'copied' ? 'Copied' : result === 'failed' ? 'Could not copy' : label}
      </Key>
      <span className="sr" role="status">
        {result === 'copied' ? 'Command copied.' : result === 'failed' ? 'Could not copy the command.' : ''}
      </span>
    </>
  );
}
