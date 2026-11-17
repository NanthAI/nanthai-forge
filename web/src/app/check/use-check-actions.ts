// SPDX-License-Identifier: Apache-2.0
// The Failed check screen's presses. Each reads or writes only when pressed: retry and undo reuse the existing
// retry-safe landing client (one operation id per press, kept across a lost reply), and the log is read once on demand.
import { useMemo, useRef, useState } from 'react';
import type { ConvexReactClient } from 'convex/react';
import type { Id } from '../../../../convex/_generated/dataModel';
import type { HostedLandingAttempt, HostedLandingState } from '../../../../src/hosted-landing';
import { BrowserLanding } from '../../lane/hosted-landing-client';
import { landingBrowserIO } from '../../lane/landing-browser-io';
import { landingFailureExcerpt } from '../../lane/landing-output';
import { hostedError } from '../../snapshot';
import type { CheckRead } from './check-model';
import { takenOutText, useTakeOut } from '../take-out';

type Busy = 'retry' | null;
type Message = { text: string; failed?: boolean } | null;

export function useCheckActions(client: ConvexReactClient, projectId: Id<'hostedProjects'>, read: CheckRead) {
  const landing = useMemo(() => new BrowserLanding(landingBrowserIO(client, projectId)), [client, projectId]);
  const operations = useRef(new Map<string, string>());
  const [busy, setBusy] = useState<Busy>(null);
  const [message, setMessage] = useState<Message>(null);
  const [copied, setCopied] = useState(false);
  const takeOut = useTakeOut(landing);
  const [log, setLog] = useState<string | null | 'loading'>(null);
  /** One operation id per action on this submission: a retried press after a lost reply reconciles, never repeats. */
  const operation = (key: string) => {
    if (!operations.current.has(key)) operations.current.set(key, crypto.randomUUID());
    return operations.current.get(key)!;
  };
  const run = async (kind: Exclude<Busy, null>, key: string, call: (id: string) => Promise<string>) => {
    setBusy(kind);
    setMessage(null);
    try {
      setMessage({ text: await call(operation(key)) });
      operations.current.delete(key);
    } catch (error) {
      setMessage({ text: hostedError(error), failed: true });
    } finally {
      setBusy(null);
    }
  };
  return {
    busy: busy ?? (takeOut.busy ? ('undo' as const) : null),
    message: takeOut.error
      ? { text: takeOut.error, failed: true }
      : takeOut.done
        ? { text: takenOutText }
        : message,
    copied,
    undone: takeOut.done,
    log,
    copy(text: string) {
      void navigator.clipboard?.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    },
    /** Retry the same exact check with the reason the cause recorded; the agent never has to pick one. */
    retry() {
      if (!read.candidateId || !read.landing) return;
      const reason = read.cause?.next.retryReason ?? 'other';
      void run('retry', `retry:${read.landing.submissionId}`, async id => {
        const current = await landing.io.query<{
          request: HostedLandingState | null;
          attempt: HostedLandingAttempt | null;
        }>('projectHostedLanding:candidate', { candidateId: read.candidateId });
        if (!current.request) throw new Error('This landing is no longer on record; land the Lane again.');
        await landing.retry(id, current.request, current.attempt?.check ?? null, reason);
        return 'Retrying the check. The Lane keeps its place; this page follows the new check.';
      });
    },
    /** Undo a landing: "Take it out of main" (web/src/app/take-out.ts), the same press on every screen. */
    undo() {
      const receiptId = read.landing?.receiptId;
      if (!receiptId || takeOut.busy) return;
      setMessage(null);
      void takeOut.press(receiptId, `Take “${read.title ?? read.laneId.slice(0, 8)}” out of main`);
    },
    /** The failing output, read once when asked: excerpts of each stream's tail, never polled. */
    readLog() {
      if (!read.run || log === 'loading') return;
      if (log !== null) return setLog(null);
      setLog('loading');
      void landingFailureExcerpt(landing.io, read.run.runId)
        .then(value => setLog(value.log))
        .catch(error => {
          setLog(null);
          setMessage({
            text: `The log did not load: ${hostedError(error)} The verdict above is Forge's own record.`,
            failed: true,
          });
        });
    },
  };
}
