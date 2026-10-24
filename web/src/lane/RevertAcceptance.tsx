import { ErrorToast } from '../ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { useRef, useState } from 'react';
import { useConvex } from 'convex/react';
import { api as hostedApi } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import type { ChannelMove } from '../../../src/work-types';
import { Button } from '../ui/primitives';
import { hostedError } from '../snapshot';
export function revertPrompt(
  move: Pick<ChannelMove, 'id' | 'viewId' | 'head' | 'previous'>,
  intentId: string,
) {
  return `Work on Intent ${intentId}. If this Intent is hosted-only, reconcile hosted metadata into the bound owner with the existing exchange workflow first. Create a new revert Lane for acceptance ${move.id} (Candidate ${move.viewId}, accepted head ${move.head}, previous main ${move.previous ?? 'none'}). Apply the reverse of that acceptance's diff on current main, preserving later accepted work. Resolve conflicts explicitly, checkpoint, check the new exact Candidate and have it accepted normally under the current autonomy policy. Main must never be rewound. This Intent and prompt do not apply the reverse diff or accept anything.`;
}
export function RevertAcceptance({
  move,
  create,
}: {
  move: ChannelMove;
  create: (operationId: string, constraints: string) => Promise<string>;
}) {
  const [operationId] = useState(() => crypto.randomUUID());
  const [intentId, setIntentId] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const createRevert = async () => {
    setBusy(true);
    setError('');
    try {
      setIntentId(await create(operationId, revertPrompt(move, operationId)));
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      {!intentId ? (
        <Button size="sm" disabled={busy} onClick={() => void createRevert()}>
          {busy ? 'Creating Intent…' : 'Revert…'}
        </Button>
      ) : (
        <>
          <p>
            Revert Intent created. Hand this prompt to an agent to create a reverse-diff Lane, then check and
            accept it normally.
          </p>
          <textarea
            className="fx-input"
            aria-label="Hand-to-agent revert prompt"
            readOnly
            rows={6}
            value={revertPrompt(move, intentId)}
          />
          <Button
            size="sm"
            onClick={() =>
              void navigator.clipboard
                .writeText(revertPrompt(move, intentId))
                .then(() => setCopied(true))
                .catch(() => setError('Could not copy. Select the prompt above.'))
            }
          >
            {copied ? 'Copied' : 'Copy hand-to-agent prompt'}
          </Button>
        </>
      )}
      {error && <ErrorToast>{error}</ErrorToast>}
    </div>
  );
}
export function HostedRevertAcceptance({
  move,
  projectId,
  base,
}: {
  move: ChannelMove;
  projectId: Id<'hostedProjects'>;
  base: string;
}) {
  const client = useConvex();
  const pinned = useRef<string | null>(null);
  return (
    <RevertAcceptance
      move={move}
      create={async (operationId, constraints) => {
        pinned.current ??= base;
        const result = await client.mutation(hostedApi.projectWorkCommand.command, {
          projectId,
          operationId,
          command: JSON.stringify({
            action: 'intent',
            outcome: `Revert acceptance ${move.id}`,
            constraints,
            base: pinned.current,
          }),
        });
        return result.operationId;
      }}
    />
  );
}
