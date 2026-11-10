// SPDX-License-Identifier: Apache-2.0
import { r2Config } from './r2';
import { deleteR2Object, listR2Prefix } from './r2Operations';
import { poolClaimPrefix, poolClaimExpirySeconds } from '../src/hosted-actions-pool';
/** Forge deletes its own claim objects, so no bucket lifecycle rule is needed: the final result
 * deletes this run's claims, then one page of other runs' claims older than their signed URLs
 * (a cancelled or crashed check never posts a final result), starting after this run's random id
 * so successive checks sweep the whole prefix. Best effort and time bounded: never fails a result. */
export async function cleanPoolClaims(projectId: string, runId: string, now = Date.now()) {
  const config = r2Config(),
    root = poolClaimPrefix(projectId),
    own = `${root}${runId}/`,
    stale = now - poolClaimExpirySeconds * 1000;
  const remove = (keys: string[]) => Promise.all(keys.map(key => deleteR2Object(config, key)));
  const work = Promise.allSettled([
    (async () => {
      // At most two pages: a run has at most maxPoolUnits (128) claims.
      let cursor: string | null = null;
      for (let page = 0; page < 2; page++) {
        const listed = await listR2Prefix(config, own, cursor);
        await remove(listed.keys);
        if (!(cursor = listed.cursor)) break;
      }
    })(),
    (async () => {
      const listed = await listR2Prefix(config, root, null, `${own}~`);
      await remove(
        listed.keys.filter((key, index) => !key.startsWith(own) && listed.modified[index]! < stale),
      );
    })(),
  ]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([work, new Promise(resolve => (timer = setTimeout(resolve, 10_000)))]);
  clearTimeout(timer);
}
