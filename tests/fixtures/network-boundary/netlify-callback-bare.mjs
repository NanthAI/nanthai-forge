// SPDX-License-Identifier: Apache-2.0
// Replay (Issue aabe52a7, 2026-11-07): the Netlify analysis worker posted its
// Convex callback with a bare fetch and its own AbortSignal.timeout, outside the
// shared helper's header/total deadlines and typed transport errors. The guard
// must reject this file when it sits under netlify/.
export async function post(site, operation, key, data) {
  const response = await fetch(`${site}/worker/${operation}`, {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${key}` },
    body: JSON.stringify(data),
  });
  return response.json();
}
