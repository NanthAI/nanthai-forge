// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { makeFunctionReference } from 'convex/server';
import { exchangeFetch } from './exchange-request.js';
import { ForgeError, invariant } from './errors.js';
import {
  ATTACHMENT_LIMITS,
  attachmentByteLimit,
  attachmentName,
  storedMediaType,
  type PlanningAttachment,
} from './discussion-attachment-limits.js';
import { hostedActionError } from './hosted-action-error.js';
import type { PlanningPort } from './hosted-agent-planning.js';

type Prepared = {
  attachment: PlanningAttachment;
  put?: { url: string; headers: Record<string, string> };
};

/** Uploads the files a comment names to R2 and returns what the comment records. Per file: one `prepare` mutation, one
 * create-only PUT of the exact bytes, one `commit` action; a retry of the same comment prepares the same objects again
 * and uploads nothing twice. The size limits are checked before a byte is read. */
export async function uploadDiscussionFiles(
  port: PlanningPort,
  itemId: string,
  commentId: string,
  files: readonly string[],
): Promise<PlanningAttachment[]> {
  invariant(
    files.length <= ATTACHMENT_LIMITS.perComment,
    'BAD_ARGUMENT',
    `Attach at most ${ATTACHMENT_LIMITS.perComment} files to one comment.`,
  );
  const attached: PlanningAttachment[] = [];
  for (const path of files) {
    const name = attachmentName(path);
    const contentType = storedMediaType(undefined, name);
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile()) throw new ForgeError('BAD_ARGUMENT', `files: ${name} is not a regular file.`);
    const limit = attachmentByteLimit(contentType);
    invariant(
      info.size > 0 && info.size <= limit,
      'BAD_ARGUMENT',
      `files: ${name} must be 1 byte to ${limit / 1_000_000} MB (${contentType.startsWith('image/') ? 'images' : 'files'}); it is ${info.size} bytes.`,
    );
    const bytes = await readFile(path);
    invariant(bytes.length === info.size, 'BAD_ARGUMENT', `files: ${name} changed while it was read.`);
    const request = {
      itemId,
      commentId,
      name,
      size: bytes.length,
      contentType,
      digest: createHash('sha256').update(bytes).digest('hex'),
    };
    const prepared = await port
      .mutation<Prepared>('discussionAttachmentUpload:prepare', request)
      .catch(error => {
        throw uploadError(error, name);
      });
    if (prepared.put) await putObject(prepared.put, bytes, name);
    await port.exchange.client
      .action(makeFunctionReference<'action'>('discussionAttachmentUpload:commit'), {
        projectId: port.address.projectId,
        itemId,
        commentId,
        attachmentId: prepared.attachment.id,
      })
      .catch(error => {
        throw uploadError(error, name);
      });
    attached.push(prepared.attachment);
  }
  return attached;
}

/** The shared mapping keeps the server's own message (it names the limit it hit); the file's name says which one. */
function uploadError(error: unknown, name: string) {
  // No feature flag: a server without the upload functions answers this way (as for the V8 command).
  if (/Could not find public function/.test(error instanceof Error ? error.message : ''))
    return new ForgeError(
      'HOSTED_ACTION_UNSUPPORTED',
      'This server does not store discussion attachments yet.',
    );
  const safe = hostedActionError(error, `attaching ${name}`);
  return safe;
}

/** The create-only PUT: its exact bytes and signed destination replay safely, so a transient failure retries. */
async function putObject(
  target: { url: string; headers: Record<string, string> },
  bytes: Buffer,
  name: string,
) {
  const headers = Object.fromEntries(
    Object.entries(target.headers).filter(([key]) => key.toLowerCase() !== 'content-length'),
  );
  const response = await exchangeFetch(
    'Discussion attachment upload',
    target.url,
    { method: 'PUT', headers, body: new Uint8Array(bytes) },
    { retries: 3 },
  );
  // A create-only retry finds the bytes already there (412); the commit still verifies them.
  if (!response.ok && response.status !== 412)
    throw new ForgeError(
      'EXCHANGE_UPLOAD_UNKNOWN',
      `Uploading ${name} returned HTTP ${response.status}. Run the same command again to reconcile.`,
    );
}
