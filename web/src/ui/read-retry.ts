// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { useEffect, useState } from 'react';
/** Rerun mounted reads without remounting editors or discarding their drafts. */
export const retryReads = () => {
  window.dispatchEvent(new Event('forge:retry-reads'));
  return false;
};
export function useReadRetry() {
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const retry = () => setAttempt(value => value + 1);
    window.addEventListener('forge:retry-reads', retry);
    return () => window.removeEventListener('forge:retry-reads', retry);
  }, []);
  return attempt;
}
