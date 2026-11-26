// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** Public contact configured for this web build. A plain address keeps mail headers out of the link. */
export function instanceContact(value: string | undefined) {
  const address = value?.trim();
  return address && /^[a-z0-9.!#$%&'*+/=^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(address)
    ? { address, href: `mailto:${encodeURIComponent(address).replace('%40', '@')}` }
    : null;
}
