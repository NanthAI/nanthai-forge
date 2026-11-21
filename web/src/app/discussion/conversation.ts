// SPDX-License-Identifier: Apache-2.0
import type { FunctionReturnType } from 'convex/server';
import type { api } from '../../../../convex/_generated/api';

export type ThreadPage = FunctionReturnType<typeof api.projectDiscussionThread.read>;
export type ThreadEntry = ThreadPage['entries'][number];
export type Answer = (entry: { id: string }, choice: string, reason?: string) => Promise<void>;
