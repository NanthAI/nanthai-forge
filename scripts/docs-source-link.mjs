// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** Build input. A distributor can link to the tree for the revision it is shipping. */
export function docsSourceLink(path, base = process.env.FORGE_DOCS_SOURCE_BASE) {
  if (!base) return undefined;
  const url = new URL(base);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('FORGE_DOCS_SOURCE_BASE must be an HTTPS source tree URL without credentials.');
  return url.href.replace(/\/$/, '') + '/' + path.split('/').map(encodeURIComponent).join('/');
}
