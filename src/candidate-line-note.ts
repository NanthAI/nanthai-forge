// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { z } from 'zod';
import type { planningCommentCommandSchema } from './work-planning-types.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const lineNote = z.strictObject({
  kind: z.literal('forge-review'),
  version: z.literal(1),
  laneId: z.uuid(),
  base: digest,
  head: digest,
  candidateId: z.uuid(),
  findings: z.tuple([
    z.strictObject({
      id: z.literal('R1'),
      severity: z.literal('should'),
      path: z.string().min(1),
      side: z.enum(['base', 'head']),
      blob: digest,
      line: z.int().positive(),
      claim: z.string().trim().min(1).max(4000),
      origin: z.enum(['changed', 'pre-existing']),
      outcome: z.literal('open'),
    }),
  ]),
});

type Note = z.infer<typeof lineNote>;
export type ReviewNoteTarget = Pick<Note, 'laneId' | 'base' | 'head' | 'candidateId'> &
  Pick<Note['findings'][0], 'path' | 'side' | 'blob' | 'line'> & { changed: boolean };

export function lineReviewText(target: ReviewNoteTarget, claim: string): string {
  const { laneId, base, head, candidateId, path, side, blob, line, changed } = target;
  const record: Note = {
    kind: 'forge-review',
    version: 1,
    laneId,
    base,
    head,
    candidateId,
    findings: [
      {
        id: 'R1',
        severity: 'should',
        path,
        side,
        blob,
        line,
        claim: claim.trim(),
        origin: changed ? 'changed' : 'pre-existing',
        outcome: 'open',
      },
    ],
  };
  return JSON.stringify(record);
}

/** A writer can add this one kind of advisory comment, not reply, label a decision or upload an attachment. */
export function candidateLineNote(command: z.infer<typeof planningCommentCommandSchema>) {
  if (
    command.replyTo ||
    command.decision ||
    command.line ||
    command.decidedBy ||
    command.attachments ||
    command.text.length > 65_536 ||
    !command.text.trimStart().startsWith('{')
  )
    return null;
  try {
    return lineNote.safeParse(JSON.parse(command.text)).data ?? null;
  } catch {
    return null;
  }
}
