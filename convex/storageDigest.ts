// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
export function storageDigest(value: string) {
  return /^[0-9a-f]{64}$/.test(value)
    ? value
    : Array.from(atob(value), byte => byte.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}
