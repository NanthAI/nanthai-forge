// SPDX-License-Identifier: Apache-2.0
/** Returns false only when an earlier, different command could not be reconciled. */
export async function reconcileBefore<T>(
  pending: { command: T } | null,
  requested: T | undefined,
  replay: () => Promise<unknown>,
): Promise<boolean> {
  if (pending && requested && JSON.stringify(pending.command) !== JSON.stringify(requested))
    return Boolean(await replay());
  return true;
}
/** Keep unknown operations with their complete payload. A different action first reconciles the old one. */
export class PendingWrite<T, R> {
  pending: { operationId: string; command: T } | null = null;
  constructor(private publish: (attempt: { operationId: string; command: T }) => Promise<R>) {}
  async send(command: T): Promise<R> {
    await reconcileBefore(this.pending, command, async () => {
      await this.publish(this.pending!);
      this.pending = null;
      return true;
    });
    const attempt = this.pending ?? { operationId: crypto.randomUUID(), command };
    this.pending = attempt;
    const result = await this.publish(attempt);
    this.pending = null;
    return result;
  }
}
