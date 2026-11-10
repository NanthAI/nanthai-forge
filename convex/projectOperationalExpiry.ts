// SPDX-License-Identifier: Apache-2.0
import { internalMutation } from './server';
import {
  checkExpiryArgs,
  sourceExpiryArgs,
  expiryResult,
  expireCheck,
  expireSource,
} from './projectOperationalExpiryPages';
import { armExpiryCatchup } from './projectOperationalExpiryCatchup';
export { catchup } from './projectOperationalExpiryCatchup';
export const check = internalMutation({
  args: checkExpiryArgs,
  returns: expiryResult,
  handler: async (ctx, input) => {
    if (input.continue !== false && !input.part) await armExpiryCatchup(ctx, input.projectId);
    return expireCheck(ctx, input);
  },
});
export const source = internalMutation({
  args: sourceExpiryArgs,
  returns: expiryResult,
  handler: async (ctx, input) => {
    if (input.continue !== false && !input.part) await armExpiryCatchup(ctx, input.projectId);
    return expireSource(ctx, input);
  },
});
