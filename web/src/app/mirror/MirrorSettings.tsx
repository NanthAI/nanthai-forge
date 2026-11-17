// SPDX-License-Identifier: Apache-2.0
// Mirror controls use policy/recovery and person-only binding removal; one retained request per retry.
import { useRef, useState } from 'react';
import { useConvex } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { AutonomyPolicy } from '../../../../src/autonomy-policy';
import { Key, Region, Row, Sheet } from '../../ds';
import { hostedError, hostedErrorCode } from '../../snapshot';

type Mirror = FunctionReturnType<typeof api.projectGithubMirrorRead.read>;
export function MirrorSettings({ mirror, projectId }: { mirror: Mirror; projectId: Id<'hostedProjects'> }) {
  const client = useConvex();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [confirm, setConfirm] = useState(false);
  const writes = useRef(new Map<string, string>());
  const removal = useRef<{ operationId: string; repoId: number; repository?: string } | null>(null);
  const paused = mirror.direction === 'off';
  const run = async (task: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setProblem('');
    try {
      await task();
    } catch (error) {
      setProblem(hostedError(error));
    } finally {
      setBusy(false);
    }
  };
  const policy = (change: { autoPush?: boolean; inbound?: boolean }) =>
    run(async () => {
      const key = JSON.stringify(change);
      let command = writes.current.get(key);
      if (!command) {
        const current = (await client.query(api.projectAutonomy.read, { projectId })) as AutonomyPolicy;
        if (!current.githubMirror) return;
        const githubMirror = { ...current.githubMirror, ...change };
        if (change.autoPush === false) githubMirror.inbound = false;
        if (change.autoPush === true && paused) githubMirror.inbound = mirror.inbound;
        command = JSON.stringify({
          action: 'set-policy',
          operationId: crypto.randomUUID(),
          expectedPolicy: current,
          githubMirror,
        });
        writes.current.set(key, command);
      }
      try {
        await client.mutation(api.projectAutonomy.set, { projectId, command });
      } catch (error) {
        if (['POLICY_CHANGED', 'BAD_ARGUMENT'].includes(hostedErrorCode(error) ?? ''))
          writes.current.delete(key);
        throw error;
      }
      writes.current.delete(key);
      if (change.autoPush) await client.mutation(api.projectGithubMirrorResume.resume, { projectId });
    });
  const disconnect = () =>
    run(async () => {
      if (!mirror.repository) return;
      removal.current ??= {
        operationId: crypto.randomUUID(),
        repoId: mirror.repoId ?? 0,
        ...(mirror.repoId == null ? { repository: mirror.repository } : {}),
      };
      try {
        await client.mutation(api.githubBindingStore.remove, { projectId, ...removal.current });
      } catch (error) {
        if (hostedErrorCode(error) === 'WORK_OPERATION_CHANGED') removal.current = null;
        throw error;
      }
      removal.current = null;
      setConfirm(false);
    });
  return (
    <Region title="Settings" hint={mirror.owner ? 'owner only' : 'only the owner changes these'}>
      <Row cols="minmax(0, 1fr) auto">
        <span>
          Push each landing to GitHub
          <span className="sub">
            One commit to main, never a force push. Lanes and other branches are never written.
          </span>
        </span>
        <span className="t2">{mirror.state === 'off' ? 'off' : paused ? 'paused' : 'on'}</span>
      </Row>
      <Row cols="minmax(0, 1fr) auto">
        <label htmlFor="mr-inbound">
          Take GitHub pushes back in
          <span className="sub">
            A push or merge on GitHub main becomes a landing and passes the same check. Off: GitHub stays a
            copy and Forge stops instead of pushing over a change made there.
          </span>
        </label>
        <input
          id="mr-inbound"
          type="checkbox"
          role="switch"
          className="sw"
          checked={mirror.inbound}
          disabled={!mirror.owner || busy || paused}
          onChange={event => void policy({ inbound: event.target.checked })}
        />
      </Row>
      <Row cols="minmax(0, 1fr) auto">
        <span>
          {paused ? 'Resume the mirror' : 'Pause the mirror'}
          <span className="sub">
            {paused
              ? 'Resume with the same repository and direction. One catch-up commit lists the paused landings it covers.'
              : 'Stop both directions and keep the link. On Resume, one catch-up commit lists the paused landings it covers.'}
          </span>
        </span>
        {mirror.owner ? (
          <Key disabled={busy} onClick={() => void policy({ autoPush: paused })}>
            {busy ? 'Changing…' : paused ? 'Resume' : 'Pause'}
          </Key>
        ) : (
          <span className="t2">owner only</span>
        )}
      </Row>
      {mirror.repository ? (
        <Row cols="minmax(0, 1fr) auto">
          <span>
            Disconnect {mirror.repository}
            <span className="sub">
              Ends the link. GitHub keeps its source and history. A stored link needs GitHub approval to
              reconnect. Any operator-configured access stays in place and can be used again without a new
              GitHub approval.
            </span>
          </span>
          {mirror.owner ? (
            <Key kind="danger" disabled={busy} onClick={() => setConfirm(true)}>
              Disconnect
            </Key>
          ) : null}
        </Row>
      ) : null}
      {problem ? (
        <p className="pad gs-err" role="alert">
          {problem}
        </p>
      ) : null}
      <Sheet
        open={confirm}
        onOpenChange={open => {
          if (!busy) setConfirm(open);
        }}
        title={`Disconnect ${mirror.repository}?`}
        footer={
          <>
            <Key autoFocus disabled={busy} onClick={() => setConfirm(false)}>
              Keep the mirror
            </Key>
            <Key kind="danger" disabled={busy} onClick={() => void disconnect()}>
              {busy ? 'Disconnecting…' : 'Disconnect'}
            </Key>
          </>
        }
      >
        <p>
          Stops the mirror in both directions and removes Forge’s claim on {mirror.repository}. GitHub keeps
          all its source and history; Forge keeps your project and Lanes.
        </p>
        <p>
          Removing a stored link also ends its runner grant for your projects. Access preconfigured by the
          service operator stays in place.
        </p>
        {problem ? (
          <p className="gs-err" role="alert">
            {problem}
          </p>
        ) : null}
      </Sheet>
    </Region>
  );
}
