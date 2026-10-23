import { ErrorToast } from '../ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { Button } from '../ui/primitives';
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false),
    [error, setError] = useState('');
  return (
    <div className="fx-copy-command">
      <code>{command}</code>
      <Button
        size="sm"
        aria-label="Copy command"
        onClick={() =>
          void navigator.clipboard.writeText(command).then(
            () => setCopied(true),
            () => setError('Could not copy. Select the command to copy it.'),
          )
        }
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
      {error && <ErrorToast>{error}</ErrorToast>}
    </div>
  );
}
