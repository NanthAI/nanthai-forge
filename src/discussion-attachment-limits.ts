// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Pure constants and helpers shared by the server, the CLI and the web page; no dependencies, so the page stays light.
/** Owner-approved limits for discussion attachments (Issue 9a3d6f5f, comment ce9bcd01, 2026-11-07):
 * 10 MB per image, 25 MB per file, 1 GB per project. Decimal megabytes, as the download route reads them. */
export const ATTACHMENT_LIMITS = {
  imageBytes: 10_000_000,
  fileBytes: 25_000_000,
  projectBytes: 1_000_000_000,
  perComment: 4,
} as const;

/** Raster formats a browser shows inline. SVG is active content and stays a plain download. */
export const INLINE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export const isInlineImage = (contentType: string) =>
  (INLINE_IMAGE_TYPES as readonly string[]).includes(contentType);
export const attachmentByteLimit = (contentType: string) =>
  isInlineImage(contentType) ? ATTACHMENT_LIMITS.imageBytes : ATTACHMENT_LIMITS.fileBytes;

/** Media types a client may declare: `type/subtype`, no parameters. Anything else is stored as a plain download. */
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,60}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,60}$/;
/** Types that the web page never renders: the download route also forces `attachment` and a sandbox policy. */
export function storedMediaType(declared: string | undefined, fileName: string) {
  const type = declared?.trim().toLowerCase();
  if (type && MEDIA_TYPE.test(type)) return type;
  const extension = /\.([a-z0-9]{1,5})$/i.exec(fileName)?.[1]?.toLowerCase();
  return (extension && EXTENSION_TYPES[extension]) || 'application/octet-stream';
}
const EXTENSION_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  zip: 'application/zip',
  log: 'text/plain',
};

/** The name shown beside an attachment: the file's last path segment, no control characters, at most 120 characters. */
export function attachmentName(raw: string) {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  return (clean || 'attachment').slice(0, 120);
}

/** What a comment records about one attachment. The server rewrites size and type from its own committed binding. */
export type PlanningAttachment = { id: string; name: string; size: number; contentType: string };
