// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// What the page does with discussion attachments (Item 9a3d6f5f): checks a file against the approved limits before a
// byte leaves the browser, uploads it straight to R2 (prepare, PUT, commit; three calls whatever its size), and reads one
// back through the authorized download route. Nothing runs until the person attaches or opens a file.
import { useCallback } from 'react';
import { ConvexError } from 'convex/values';
import { useAction, useMutation } from 'convex/react';
import { useAuthToken } from '@convex-dev/auth/react';
import { makeFunctionReference } from 'convex/server';
import type { Id } from '../../../../convex/_generated/dataModel';
import {
  ATTACHMENT_LIMITS,
  attachmentByteLimit,
  attachmentName,
  storedMediaType,
  type PlanningAttachment,
} from '../../../../src/discussion-attachment-limits';

/** A refusal the person can act on, in words: shown by the composer instead of the generic "not sent". */
export class AttachmentProblem extends Error {}

type PrepareArgs = {
  projectId: Id<'hostedProjects'>;
  itemId: string;
  commentId: string;
  name: string;
  size: number;
  contentType: string;
  digest: string;
};
type Prepared = {
  attachment: PlanningAttachment;
  put?: { url: string; headers: Record<string, string> };
};
const prepareFile = makeFunctionReference<'mutation', PrepareArgs, Prepared>(
  'discussionAttachmentUpload:prepare',
);
const commitFile = makeFunctionReference<
  'action',
  Omit<PrepareArgs, 'name' | 'size' | 'contentType' | 'digest'> & { attachmentId: string },
  null
>('discussionAttachmentUpload:commit');

const megabytes = (bytes: number) => `${bytes / 1_000_000} MB`;
/** The limit a file meets, checked before reading it. Returns the sentence to show, or null when it fits. */
export function attachmentRefusal(file: Pick<File, 'name' | 'size' | 'type'>) {
  const name = attachmentName(file.name);
  const limit = attachmentByteLimit(storedMediaType(file.type, name));
  if (file.size === 0) return `${name} is empty.`;
  if (file.size > limit)
    return `${name} is over the ${megabytes(limit)} limit${limit === ATTACHMENT_LIMITS.imageBytes ? ' for images' : ' for files'}.`;
  return null;
}
const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');

const words = (error: unknown) => {
  const data = error instanceof ConvexError ? (error.data as { message?: unknown } | null) : null;
  return typeof data?.message === 'string' ? data.message : null;
};

/** Uploads files for the comment `commentId` and returns what the comment records. A retry of the same comment
 * prepares the same objects, so nothing is stored twice. */
export function useAttachmentUpload(projectId: Id<'hostedProjects'>, itemId: string) {
  const prepare = useMutation(prepareFile);
  const commit = useAction(commitFile);
  return useCallback(
    async (files: readonly File[], commentId: string): Promise<PlanningAttachment[]> => {
      if (files.length > ATTACHMENT_LIMITS.perComment)
        throw new AttachmentProblem(`A comment holds at most ${ATTACHMENT_LIMITS.perComment} files.`);
      for (const file of files) {
        const refusal = attachmentRefusal(file);
        if (refusal) throw new AttachmentProblem(refusal);
      }
      const attached: PlanningAttachment[] = [];
      for (const file of files) {
        try {
          const name = attachmentName(file.name);
          const bytes = await file.arrayBuffer();
          const prepared = await prepare({
            projectId,
            itemId,
            commentId,
            name,
            size: file.size,
            contentType: storedMediaType(file.type, name),
            digest: hex(await crypto.subtle.digest('SHA-256', bytes)),
          });
          if (prepared.put) {
            // The browser supplies Content-Length from the body; JavaScript cannot set it.
            const headers = Object.fromEntries(
              Object.entries(prepared.put.headers).filter(([key]) => key.toLowerCase() !== 'content-length'),
            );
            const response = await fetch(prepared.put.url, {
              method: 'PUT',
              headers,
              body: new Blob([bytes]),
            });
            // The reply is empty; reading it releases the connection.
            await response.arrayBuffer().catch(() => null);
            // A create-only retry finds the bytes already there (412); the commit still verifies them.
            if (!response.ok && response.status !== 412)
              throw new AttachmentProblem(
                `${name} could not be uploaded (HTTP ${response.status}). Try again.`,
              );
          }
          await commit({ projectId, itemId, commentId, attachmentId: prepared.attachment.id });
          attached.push(prepared.attachment);
        } catch (error) {
          const message = words(error);
          if (message) throw new AttachmentProblem(message);
          throw error;
        }
      }
      return attached;
    },
    [prepare, commit, projectId, itemId],
  );
}

/** The deployment's HTTP routes: the `.convex.site` twin of the `.convex.cloud` client address. */
function routeOrigin() {
  const base = import.meta.env.VITE_CONVEX_URL as string | undefined;
  if (!base) return location.origin;
  const url = new URL(base);
  return url.host.endsWith('.convex.cloud')
    ? `https://${url.host.replace(/\.convex\.cloud$/, '.convex.site')}`
    : url.origin;
}

export type AttachmentRead = { ok: true; bytes: Blob } | { ok: false; message: string };
/** Reads one attachment through the download route, as the signed-in viewer. The route checks access, charges the
 * daily download cap and answers 429 with the cap and its reset time, which is shown as it is. */
export function useAttachmentRead(projectId: Id<'hostedProjects'>, itemId: string) {
  const token = useAuthToken();
  return useCallback(
    async (commentId: string, attachmentId: string): Promise<AttachmentRead> => {
      if (!token) return { ok: false, message: 'Sign in to open attachments.' };
      try {
        const response = await fetch(
          `${routeOrigin()}/discussion/attachment?${new URLSearchParams({ projectId, itemId, commentId, attachmentId })}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (response.ok) return { ok: true, bytes: await response.blob() };
        const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
        return {
          ok: false,
          message: typeof body?.message === 'string' ? body.message : 'This attachment is unavailable.',
        };
      } catch {
        return { ok: false, message: 'This attachment could not be read. Try again.' };
      }
    },
    [token, projectId, itemId],
  );
}
