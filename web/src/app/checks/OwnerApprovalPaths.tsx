// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { useId, useRef, useState, type FormEvent } from 'react';
import { useConvex } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { globPattern, type AutonomyPolicy } from '../../../../src/autonomy-policy';
import { effectiveOwnerApprovalPaths } from '../../../../src/owner-approval-paths';
import { Key, Region } from '../../ds';
import { PendingWrite } from '../../pending-write';
import { hostedError } from '../../snapshot';

export function OwnerApprovalPaths({
  policy,
  projectId,
  owner,
  onDone,
}: {
  policy: AutonomyPolicy;
  projectId: Id<'hostedProjects'>;
  owner: boolean;
  onDone: () => void;
}) {
  const current = effectiveOwnerApprovalPaths(policy.acceptance.ownerApprovalPaths).join('\n');
  const [draft, setDraft] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const id = useId();
  const client = useConvex();
  const write = useRef<PendingWrite<{ expectedPolicy: AutonomyPolicy; paths: string[] }, void> | null>(null);
  write.current ??= new PendingWrite(async ({ operationId, command }) => {
    await client.mutation(api.projectAutonomy.set, {
      projectId,
      command: JSON.stringify({
        action: 'set-policy',
        governanceVersion: 1,
        operationId,
        expectedPolicy: command.expectedPolicy,
        acceptance: { ownerApprovalPaths: command.paths },
      }),
    });
  });
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!owner || busy || draft === undefined) return;
    setError('');
    const paths = draft
      .split('\n')
      .map(path => path.trim())
      .filter(Boolean);
    try {
      paths.forEach(globPattern);
      setBusy(true);
      await write.current!.send({ expectedPolicy: policy, paths });
      setDraft(undefined);
      onDone();
    } catch (failure) {
      setError(hostedError(failure));
      onDone();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Region title="Paths that need owner approval" hint={owner ? undefined : 'only the owner changes this'}>
      <form className="pad gs-stack" onSubmit={submit}>
        <label className="field" htmlFor={id}>
          Repository path patterns
          <textarea
            className="inp"
            id={id}
            rows={6}
            spellCheck={false}
            value={draft ?? current}
            readOnly={!owner}
            disabled={busy}
            aria-describedby={`${id}-help`}
            onChange={event => setDraft(event.target.value)}
          />
        </label>
        <p className="meta" id={`${id}-help`}>
          Enter one pattern per line. Configured check and setup entry files always require owner approval.
        </p>
        {error ? (
          <p className="gs-err" role="alert">
            {error}
          </p>
        ) : null}
        {owner ? (
          <div className="btns">
            <Key type="submit" size="sm" disabled={busy || draft === undefined || draft === current}>
              {busy ? 'Saving…' : 'Save paths'}
            </Key>
          </div>
        ) : null}
      </form>
    </Region>
  );
}
