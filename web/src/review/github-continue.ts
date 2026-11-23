// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** Item c63c2171: a granted connect continues to GitHub's own authorization, and only there. */
export function githubContinue(reply: unknown): string | null {
  const url = (reply as { applied?: { authorizeUrl?: unknown } } | null)?.applied?.authorizeUrl;
  if (typeof url !== 'string') return null;
  try {
    const target = new URL(url);
    return target.protocol === 'https:' && target.host === 'github.com' ? target.href : null;
  } catch {
    return null;
  }
}
