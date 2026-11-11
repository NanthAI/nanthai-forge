// SPDX-License-Identifier: Apache-2.0
import { useEffect, useMemo, useRef, useState } from 'react';
import { useConvex } from 'convex/react';
import { watchLandingHistory } from './landing-history';
import type { Id } from '../../../convex/_generated/dataModel';
import { BrowserLanding } from './hosted-landing-client';
import { landingBrowserIO } from './landing-browser-io';
import type { LandingRead } from './landing-model';
import { hostedError } from '../snapshot';
import { landingFailureExcerpt } from './landing-output';
import { useReadRetry } from '../ui/read-retry';
import { useToast } from '../ui/Toast';
import { ownerApprove, ownerDecline } from './owner-review-api';
// Keeps original operation IDs over route changes and ambiguous replies in this page.
const clients = new WeakMap<object, Map<string, BrowserLanding>>();
const operations = new Map<string, string>();
export function useHostedLanding(projectId: Id<'hostedProjects'>, candidateId: string, outcome: string) {
  const client = useConvex(),
    toast = useToast();
  const landing = useMemo(() => {
    if (!clients.has(client)) clients.set(client, new Map());
    const cache = clients.get(client)!;
    if (!cache.has(projectId)) cache.set(projectId, new BrowserLanding(landingBrowserIO(client, projectId)));
    return cache.get(projectId)!;
  }, [client, projectId]);
  const [reversing, setReversing] = useState(false),
    [reverseId, setReverseId] = useState('');
  const retryRead = useReadRetry();
  const candidateKey = `${projectId}:${candidateId}`;
  const [history, setHistory] = useState<{ key: string; value: unknown }>({ key: '', value: null });
  const candidate = history.key === candidateKey ? (history.value as LandingRead | null) : null;
  const read = candidate?.request ? candidate : null;
  const readyRun = candidate?.run ?? null;
  const reverseCandidateId = reverseId || read?.reverseCandidateId;
  const [reverseHistory, setReverseHistory] = useState<{ key: string; value: unknown }>({
    key: '',
    value: null,
  });
  const reverseKey = `${projectId}:${reverseCandidateId}`;
  const reverseRead = reverseHistory.key === reverseKey ? (reverseHistory.value as LandingRead | null) : null;
  useEffect(
    () =>
      watchLandingHistory(
        client,
        'projectHostedLanding:candidate',
        { projectId, candidateId },
        value => setHistory({ key: candidateKey, value }),
        e => {
          setHistory({ key: candidateKey, value: null });
          setError(hostedError(e));
        },
      ),
    [client, projectId, candidateId, candidateKey, retryRead],
  );
  useEffect(
    () =>
      reverseCandidateId
        ? watchLandingHistory(
            client,
            'projectHostedLanding:candidate',
            { projectId, candidateId: reverseCandidateId },
            value => setReverseHistory({ key: reverseKey, value }),
            e => {
              setReverseHistory({ key: reverseKey, value: null });
              setError(hostedError(e));
            },
          )
        : undefined,
    [client, projectId, reverseCandidateId, reverseKey, retryRead],
  );
  const [excerpt, setExcerpt] = useState<{ id: string; failures: string[]; log: string }>({
    id: '',
    failures: [],
    log: '',
  });
  const failedRun = readyRun?.status === 'failed' ? readyRun.id : '';
  useEffect(() => {
    let active = true;
    if (failedRun)
      void landingFailureExcerpt(landing.io, failedRun)
        .then(value => {
          if (active) setExcerpt({ id: failedRun, ...value });
        })
        .catch(e => {
          if (active) setError(hostedError(e));
        });
    return () => {
      active = false;
    };
  }, [failedRun, landing, retryRead]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const previous = useRef<string | null>(null),
    toasted = useRef(new Set<string>());
  useEffect(() => {
    const state = read?.request.observation.state;
    if (state === 'landed' && previous.current === 'pending' && !toasted.current.has(read!.request.id)) {
      toasted.current.add(read!.request.id);
      toast.show({ message: `Accepted · ${outcome} landed on main`, tone: 'success', accepted: true });
    }
    previous.current = state ?? null;
  }, [read?.request.id, read?.request.observation.state, outcome, toast]);
  const invoke = async (kind: string, call: (id: string) => Promise<unknown>) => {
    const key = `${projectId}:${candidateId}:${kind}`;
    if (!operations.has(key)) operations.set(key, crypto.randomUUID());
    setBusy(true);
    setError('');
    try {
      const result = await call(operations.get(key)!);
      operations.delete(key);
      return result;
    } catch (e) {
      setError(hostedError(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return {
    read,
    reverseRead,
    readyRun,
    reversing,
    busy,
    error,
    failures: excerpt.id === failedRun ? excerpt.failures : [],
    log: excerpt.id === failedRun ? excerpt.log : '',
    accept: (runId?: string) => {
      const failed =
        reverseRead?.request.phase === 'terminal-failed'
          ? reverseRead
          : read?.request.phase === 'terminal-failed'
            ? read
            : null;
      return failed
        ? invoke(`retry:${failed.request.id}`, id => landing.retry(id, failed.request, failed.attempt.check))
        : invoke('accept', id => landing.accept(id, candidateId, runId));
    },
    // Owner review of the exact held attempt this page shows (fe5bea80); the server re-checks both.
    approve: () =>
      read ? invoke(`approve:${read.attempt.id}`, () => ownerApprove(landing.io, read)) : Promise.resolve(),
    decline: (why: string) =>
      read
        ? invoke(`decline:${read.attempt.id}`, id => ownerDecline(landing.io, read, id, why))
        : Promise.resolve(),
    cancel: () => {
      const selected = reverseRead?.request.observation.state === 'pending' ? reverseRead : read;
      return selected
        ? invoke(`cancel:${selected.request.id}`, id => landing.cancel(id, selected.request))
        : Promise.resolve();
    },
    revert: (receiptId: string, why: string) =>
      invoke('revert', async id => {
        setReversing(true);
        try {
          const result = await landing.revert(id, receiptId, why);
          setReverseId(result.candidateId);
          return result;
        } finally {
          setReversing(false);
        }
      }),
  };
}
