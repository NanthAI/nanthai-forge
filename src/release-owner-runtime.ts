// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { z } from 'zod';
import { processIdentity } from './local-process.js';
import { releaseJson, releaseSave } from './maintainer-release-files.js';

export const ownerRuntimeSchema = z.object({
  pid: z.number().int().positive(),
  startTime: z.string().min(1),
  executablePath: z.string().min(1),
  owner: z.string(),
  port: z.number().int(),
  token: z.string(),
});
export type OwnerRuntime = z.infer<typeof ownerRuntimeSchema>;
export const publicOwnerRuntime = ({ token: _token, ...runtime }: OwnerRuntime) => runtime;
export function readOwnerRuntime(directory: string) {
  try {
    return ownerRuntimeSchema.parse(releaseJson(join(directory, 'owner-runtime.json')));
  } catch {
    return undefined;
  }
}
/** Private discovery for release verification; the token never enters release receipts. */
export function retainOwnerRuntime(directory: string, owner: string, port: number, token: string) {
  const runtime: OwnerRuntime = {
    ...processIdentity(),
    executablePath: fileURLToPath(new URL('./cli.js', import.meta.url)),
    owner,
    port,
    token,
  };
  releaseSave(join(directory, 'owner-runtime.json'), runtime);
  return {
    runtime: publicOwnerRuntime(runtime),
    close() {
      try {
        const current = readOwnerRuntime(directory);
        if (
          current?.pid === runtime.pid &&
          current.startTime === runtime.startTime &&
          current.token === runtime.token
        )
          rmSync(join(directory, 'owner-runtime.json'), { force: true });
      } catch {
        // A stale discovery file is rejected by the release's live identity
        // probe; failure to remove advisory metadata must not prevent close.
      }
    },
  };
}
