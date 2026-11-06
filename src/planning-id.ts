// SPDX-License-Identifier: Apache-2.0
// Pure: runs in the CLI and in the Convex non-Node runtime.

/** Shortest planning id prefix a read or write accepts (the 8 characters briefs and receipts print). */
export const planningIdMinPrefix = 8;
/** Most candidate ids an ambiguous prefix lists. */
export const planningIdMaxCandidates = 5;
export const planningIdShape = 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx';
export const planningIdHelp = `a complete planning UUID (${planningIdShape}) or a unique hex prefix of at least ${planningIdMinPrefix} characters`;

const fullId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const prefix = /^[0-9a-f]{8}(?:-|[0-9a-f])*$/i;

/** A complete planning UUID: used exactly as given, never resolved. */
export const isPlanningUuid = (value: string) => fullId.test(value);
/** 8-35 hex characters (dashes allowed after the first 8) that are not a complete UUID. */
export const isPlanningPrefix = (value: string) =>
  value.length < 36 && prefix.test(value) && !value.includes('--') && !fullId.test(value);
/** An id a planning read or write accepts: a complete UUID or a prefix to resolve. */
export const isPlanningRef = (value: string) => isPlanningUuid(value) || isPlanningPrefix(value);
