// SPDX-License-Identifier: Apache-2.0
// Incident replay (Issue 06cfc7b7, 2026-11-02): an OIDC token read with a bare
// fetch and its own AbortSignal.timeout ran outside the shared helper, so the
// helper's typed transient errors and bounded retry never applied to it.
// The guard must reject this file when it sits under scripts/ or src/.
export async function oidcToken(endpoint, request, audience) {
  const url = new URL(endpoint);
  url.searchParams.set('audience', audience);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${request}` },
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  return (await response.json()).value;
}
