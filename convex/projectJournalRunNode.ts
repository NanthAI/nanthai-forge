// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import { journalPackArgs, packJournal } from './projectJournalRun';

/** The same packer for a page whose captured text exceeds the V8 packer's memory bound. */
export const pack = internalAction({
  args: journalPackArgs,
  returns: v.string(),
  handler: (ctx, input) => packJournal(ctx, input, 'node'),
});
