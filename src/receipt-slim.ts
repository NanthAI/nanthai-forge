// SPDX-License-Identifier: Apache-2.0
type Json = Record<string, unknown>;
const omit = (value: Json, ...keys: string[]): Json =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const obj = (value: unknown): Json | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;

/**
 * The receipt an agent reads, without the parts it already holds (Issue 47558a99). Every field removed
 * here is derivable from a kept field or one follow-up read: overlap participants live once in
 * `overlapNotice`, an advisory notice needs no answer commands, a checkout repeats its Lane, a clean
 * main-distance repeats heads and a healthy mirror reports only its status. Applied where a receipt leaves
 * the process (CLI stdout, MCP reply), never to the in-process response or the hosted wire contract, so
 * older and newer CLIs and servers still agree. `--detail` on the CLI prints the full receipt.
 */
export function slimReceipt<T>(receipt: T): T {
  const top = obj(receipt);
  if (!top || top.transport !== 'hosted') return receipt;
  const out: Json = { ...top };
  const notice = obj(top.overlapNotice);
  const overlaps = obj(top.unacknowledgedOverlaps);
  if (notice && overlaps && Array.isArray(overlaps.items)) {
    // The notice lists each notice id, file and other Lane once; keep the counts and coverage here.
    out.unacknowledgedOverlaps = omit(overlaps, 'items', 'laneId', 'head');
  }
  if (notice) {
    const { acknowledge, routeAround } = notice;
    const rest = omit(notice, 'choices', 'acknowledge', 'routeAround', 'summary');
    out.overlapNotice = notice.required
      ? { ...rest, acknowledge, routeAround }
      : {
          ...rest,
          note: 'Advisory: no answer needed. Blocking notices carry acknowledge/routeAround commands.',
        };
  }
  const behind = obj(top.behindMain);
  if (behind && behind.commits === 0 && !behind.more && !(behind.conflictingPaths as unknown[])?.length)
    out.behindMain = { commits: 0, coverage: behind.coverage };
  const result = obj(top.result);
  if (result) {
    const slim: Json = { ...result };
    const lane = obj(result.lane),
      checkout = obj(result.checkout);
    if (lane && checkout)
      slim.checkout = Object.fromEntries(
        Object.entries(checkout).filter(
          ([key, value]) => JSON.stringify(lane[key]) !== JSON.stringify(value),
        ),
      );
    const mirror = obj(result.githubMirror);
    if (mirror && mirror.status === 'synced' && !mirror.lagging && !mirror.failures && !mirror.error)
      slim.githubMirror = {
        status: 'synced',
        ...(mirror.repository ? { repository: mirror.repository } : {}),
      };
    // preflight lists every deferred test file (hundreds); the receipt already counts them and the landing
    // check runs them.
    const plan = obj(result.plan);
    if (plan && Array.isArray(plan.deferredTests)) {
      const { deferredTests, ...rest } = plan;
      slim.plan = { ...rest, deferredTestCount: deferredTests.length };
    }
    // peers repeats its overlap list inside peerEvidence; keep the evidence and the counts.
    const peerOverlaps = obj(result.unacknowledgedOverlaps);
    if (peerOverlaps && obj(result.peerEvidence)) {
      slim.unacknowledgedOverlaps = omit(peerOverlaps, 'items', 'laneId', 'head');
    }
    // A save repeats its Lane, operation and time inside the outcome the receipt already names.
    const outcome = obj(result.outcome),
      saved = obj(outcome?.result);
    if (outcome && saved && saved.laneId !== undefined) {
      const keep = omit(saved, 'laneId', 'operationId', 'at');
      slim.outcome = { ...outcome, result: saved.at === result.at ? keep : { ...keep, at: saved.at } };
    }
    out.result = slim;
  }
  return out as T;
}
