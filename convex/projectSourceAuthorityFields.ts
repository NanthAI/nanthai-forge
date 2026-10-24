// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';

export const sourceAuthority = v.object({
  mode: v.union(v.literal('native-owner'), v.literal('server-shadow'), v.literal('server')),
  epoch: v.number(),
});
