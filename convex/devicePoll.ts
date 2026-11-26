// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import { invariant } from '../src/errors';
import { digest } from '../src/state/hash';

/** An ordinary poll stays in V8. Only an approved redemption needs the signer. */
export async function pollDevice(ctx: ActionCtx, input: unknown) {
  const args = input as { deviceCode?: unknown; operationId?: unknown } | null;
  invariant(
    typeof args?.deviceCode === 'string' &&
      /^[0-9a-f]{64}$/.test(args.deviceCode) &&
      typeof args.operationId === 'string' &&
      /^[0-9a-f-]{36}$/i.test(args.operationId),
    'BAD_ARGUMENT',
    'Use the original device code and operation UUID.',
  );
  const result = await ctx.runMutation(internal.deviceStore.poll, {
    deviceHash: digest(args.deviceCode),
    operationId: args.operationId,
  });
  return result.device
    ? ctx.runAction(internal.deviceActions.signPoll, { device: result.device })
    : { status: result.status };
}
