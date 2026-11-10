// SPDX-License-Identifier: Apache-2.0
import { hostedMainV2Schema, type HostedMainV2 } from './hosted-main.js';

/** This command's early capability read, by deployment and project (one per process). */
const reads = new Map<string, Promise<unknown>>();
const key = (url: string, projectId: string) => JSON.stringify([url.replace(/\/+$/, ''), projectId]);

export function noteEarlyCapabilities(url: string, projectId: string, read: Promise<unknown>) {
  reads.set(key(url, projectId), read);
}

/** Main as projectHostedChannels:current returns it, carried by this command's own capability read of
 * the same project (feature capabilities-main, 686ecdde), or null. Never a call: the release check
 * of an agent command in the CLI's release project takes it instead of its own current read. */
export async function carriedMain(url: string, projectId: string): Promise<HostedMainV2 | null> {
  const read = reads.get(key(url, projectId));
  if (!read) return null;
  try {
    const parsed = hostedMainV2Schema.safeParse(((await read) as { main?: unknown } | null)?.main);
    return parsed.success && parsed.data.projectId === projectId ? parsed.data : null;
  } catch {
    return null; // The command's own dispatch reports a failed discovery in its own words.
  }
}
