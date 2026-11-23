// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { useState } from 'react';
import { Key } from '../../ds';

/** Copy only a constructed, value-free command. A failed clipboard never echoes the browser exception. */
export function SecretCommand({ command, small = false }: { command: string; small?: boolean }) {
  const [result, setResult] = useState<'copied' | 'failed' | null>(null);
  return (
    <span className="secret-command">
      <Key
        size={small ? 'sm' : undefined}
        title="Proposed command; the sealed-secret protocol is not available yet"
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
        {result === 'copied' ? 'Copied' : small ? 'Copy command' : `Copy: ${command}`}
      </Key>
      <span className="t3">Proposed</span>
      <span className="sr" role="status">
        {result === 'copied' ? 'Command copied.' : result === 'failed' ? 'Could not copy the command.' : ''}
      </span>
    </span>
  );
}
