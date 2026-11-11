// SPDX-License-Identifier: Apache-2.0
import { watchLandingHistory } from './lane/landing-history';
import { useEffect, useMemo, useRef, useState } from 'react';
import { SignInButton } from '@clerk/react';
import { useConvex, useConvexAuth } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import type { Id } from '../../convex/_generated/dataModel';
import { Button } from './ui/primitives';
import { Shell } from './shell/Shell';
import { hostedError } from './snapshot';
import { landingBrowserIO } from './lane/landing-browser-io';
import { ownerApprove, ownerDecline } from './lane/owner-review-api';
import { OwnerApproval, type OwnerApprovalPhase } from './review/OwnerApproval';
import { LaneApproval, type LaneApprovalPhase, type LaneApprovalRead } from './review/LaneApproval';
import type { HostedLandingAttempt, HostedLandingState } from '../../src/hosted-landing';

type Read = { request: HostedLandingState; attempt: HostedLandingAttempt };
const approvalRead = makeFunctionReference<
  'query',
  { projectId: Id<'hostedProjects'>; laneId: string; detail: 1 },
  string
>('projectHostedApprovals:observe');
/** One live read; null when unreadable. */
function useLive<T>(
  enabled: boolean,
  watch: () => { localQueryResult(): string | undefined; onUpdate(callback: () => void): () => void },
  keys: unknown[],
) {
  const [read, setRead] = useState<T | null | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    const live = watch();
    const update = () => {
      try {
        const value = live.localQueryResult();
        if (value !== undefined) setRead(JSON.parse(value) as T);
      } catch {
        setRead(null);
      }
    };
    const stop = live.onUpdate(update);
    update();
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...keys]);
  return read;
}
/**
 * /approve?project=…&submission=…: the link `nforge agent ROOT approve-link` prints (Issue fe5bea80).
 * One live read of the submission; the attempt to accept comes from that read, never from the link.
 * /approve?project=…&lane=…: the link `request-approval` prints, for a Lane's approval request.
 */
export default function OwnerApprove() {
  return new URLSearchParams(location.search).get('lane') ? <LaneApprove /> : <LandingApprove />;
}
function LaneApprove() {
  const { isAuthenticated, isLoading } = useConvexAuth(),
    client = useConvex();
  const params = new URLSearchParams(location.search);
  const projectId = (params.get('project') ?? '') as Id<'hostedProjects'>,
    laneId = params.get('lane') ?? '';
  const io = useMemo(() => landingBrowserIO(client, projectId), [client, projectId]);
  const read = useLive<LaneApprovalRead>(
    isAuthenticated && Boolean(projectId && laneId),
    () => client.watchQuery(approvalRead, { projectId, laneId, detail: 1 }),
    [client, projectId, laneId],
  );
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  // An unfinished attempt keeps its operation id, so a retry after an unknown reply is one decision.
  const attempt = useRef<{ key: string; operationId: string } | null>(null);
  const decide = async (decision: 'grant' | 'decline', why = '') => {
    if (!read?.currentHead) return;
    const key = JSON.stringify([decision, read.currentHead, why.trim()]);
    if (attempt.current?.key !== key) attempt.current = { key, operationId: crypto.randomUUID() };
    setBusy(true);
    setError('');
    try {
      await io.mutation('projectHostedApprovals:decide', {
        operationId: attempt.current.operationId,
        laneId,
        decision,
        head: read.currentHead,
        ...(why.trim() ? { reason: why.trim() } : {}),
      });
      attempt.current = null;
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setBusy(false);
    }
  };
  const phase: LaneApprovalPhase = isLoading
    ? { kind: 'loading' }
    : !isAuthenticated
      ? { kind: 'signed-out' }
      : !projectId || !laneId || read === null
        ? { kind: 'missing' }
        : read === undefined
          ? { kind: 'loading' }
          : { kind: 'read', approval: read };
  return (
    <Shell tabs={[]} current="" onTab={() => undefined} label="Forge">
      <LaneApproval
        phase={phase}
        error={error}
        laneHref={
          laneId.startsWith('setting:')
            ? undefined
            : `/?project=${encodeURIComponent(projectId)}&projectTab=lanes&lane=${encodeURIComponent(laneId)}`
        }
        review={{ busy, accept: () => void decide('grant'), decline: why => void decide('decline', why) }}
        signIn={
          <SignInButton mode="modal">
            <Button variant="primary" size="lg">
              Sign in to review
            </Button>
          </SignInButton>
        }
      />
    </Shell>
  );
}
function LandingApprove() {
  const { isAuthenticated, isLoading } = useConvexAuth(),
    client = useConvex();
  const params = new URLSearchParams(location.search);
  const projectId = (params.get('project') ?? '') as Id<'hostedProjects'>,
    submissionId = params.get('submission') ?? '';
  const io = useMemo(() => landingBrowserIO(client, projectId), [client, projectId]);
  const [read, setRead] = useState<Read | null | undefined>(undefined),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [declineId] = useState(() => crypto.randomUUID());
  useEffect(() => {
    if (!isAuthenticated || !projectId || !submissionId) return;
    setRead(undefined);
    return watchLandingHistory(
      client,
      'projectHostedLanding:status',
      { projectId, submissionId },
      value => setRead(value as Read | null | undefined),
      () => setRead(null),
    );
  }, [client, isAuthenticated, projectId, submissionId]);
  const act = async (call: (held: Read) => Promise<unknown>) => {
    if (!read) return;
    setBusy(true);
    setError('');
    try {
      await call(read);
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setBusy(false);
    }
  };
  const phase: OwnerApprovalPhase = isLoading
    ? { kind: 'loading' }
    : !isAuthenticated
      ? { kind: 'signed-out' }
      : !projectId || !submissionId || read === null
        ? { kind: 'missing' }
        : read === undefined
          ? { kind: 'loading' }
          : { kind: 'read', request: read.request, agent: read.attempt.actor.kind === 'agent' };
  const reviewHref = read
    ? `/?project=${encodeURIComponent(projectId)}&projectTab=intent&intentTab=delivery&reviewView=${encodeURIComponent(read.attempt.candidate.id)}`
    : undefined;
  return (
    <Shell tabs={[]} current="" onTab={() => undefined} label="Forge">
      <OwnerApproval
        phase={phase}
        error={error}
        reviewHref={reviewHref}
        review={{
          busy,
          accept: () => void act(held => ownerApprove(io, held)),
          decline: why => void act(held => ownerDecline(io, held, declineId, why)),
        }}
        signIn={
          <SignInButton mode="modal">
            <Button variant="primary" size="lg">
              Sign in to review
            </Button>
          </SignInButton>
        }
      />
    </Shell>
  );
}
