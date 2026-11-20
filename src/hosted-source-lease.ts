// SPDX-License-Identifier: Apache-2.0
/** A source step's worker lease as its begin read it: the lease length, and how long it had left,
 * measured on the server's clock inside begin. The step never compares the server's deadline with
 * its own clock: it times renewals from when it received this. */
type SourceStepLease = { ms: number; remainingMs: number };
/** The longest a step renews its own lease: the platform's action time limit. */
const sourceLeaseRenewLimitMs = 600_000;
/** Keeps a running source step's worker lease alive from inside the step (incident e62d834b: steps
 * that ran past the fixed 60 s lease were fenced while still working). The first renewal is due once
 * the step has used half the lease it had left at begin (30 s on a fresh 60 s lease); later ones
 * every third of the lease, so one renewal can be late or lost without fencing the step. A step that
 * finishes inside that first half makes no call. Renewal stops when the step ends (the returned
 * stop), when the server refuses it (the step is no longer current: `renew` resolved false), or
 * after the action time limit. A renewal call that fails tries again after a sixth of the lease, so a
 * failed first renewal (at half the lease) still has a second try well inside it (review d5614319). */
export function keepSourceLease(
  renew: () => Promise<boolean>,
  lease: SourceStepLease | undefined,
): () => Promise<void> {
  if (!lease || !(lease.ms > 0) || !(lease.remainingMs > 0)) return async () => {};
  const every = Math.max(1, Math.floor(lease.ms / 3)),
    again = Math.max(1, Math.floor(lease.ms / 6)),
    stopAt = performance.now() + sourceLeaseRenewLimitMs;
  let timer: ReturnType<typeof setTimeout> | undefined,
    stopped = false,
    pending: Promise<void> = Promise.resolve();
  const arm = (ms: number) => {
    if (stopped || performance.now() + ms > stopAt) return;
    timer = setTimeout(() => {
      timer = undefined;
      pending = renew().then(
        kept => {
          if (kept) arm(every);
        },
        () => arm(again),
      );
    }, ms);
  };
  arm(Math.max(1, Math.floor(Math.min(lease.remainingMs, lease.ms) / 2)));
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await pending;
  };
}
