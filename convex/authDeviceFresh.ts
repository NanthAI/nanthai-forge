// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './server';
/** The existing ten-minute proof window is bound to the browser's live session. */
export function freshDeviceApproval(identity: Record<string, unknown>) {
  return (
    typeof identity.forgeAuthDeviceVerifiedUntil === 'number' &&
    identity.forgeAuthDeviceVerifiedUntil > Date.now()
  );
}
/** Only trusted library sign-in results reach this helper; refresh never refreshes this proof. */
export async function recordFreshBrowser(ctx: MutationCtx, value: unknown) {
  const result = value as { status?: string; tokens?: { accessToken?: string; userId?: string } } | null;
  if (result?.status !== 'complete' || !result.tokens?.accessToken || !result.tokens.userId) return;
  const payload = result.tokens.accessToken.split('.')[1]!;
  const sessionId = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))).sub;
  const id = ctx.db.normalizeId('users', result.tokens.userId);
  if (id && typeof sessionId === 'string')
    await ctx.db.patch(id, { deviceApprovalProof: { sessionId, verifiedUntil: Date.now() + 600000 } });
}
