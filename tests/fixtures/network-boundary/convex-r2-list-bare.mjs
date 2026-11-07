// SPDX-License-Identifier: Apache-2.0
// Replay (Issue aabe52a7, 2026-11-07): convex/r2Operations.ts listed R2 with a
// bare fetch and no deadline, and GitHub App calls defaulted their injected
// request to the bare global, so a stalled socket held the action until the
// platform limit. The guard must reject this file when it sits under convex/.
export async function listPage(url) {
  const response = await fetch(url);
  return response.ok ? response.text() : '';
}
export async function githubAppRequest(path, token, request = fetch) {
  return request(`https://api.github.com/${path}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
}
