// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { z } from 'zod';
import { decideInputSchema, decisionsInputSchema, decisionRecordSchema } from './decision-types.js';
import {
  frictionRef,
  frictionInputSchema,
  frictionEventSchema,
  frictionListSchema,
  hostedFrictionTriageSchema,
} from './friction-types.js';
// Report abuse (Item b6588425 line 2): the input the CLI `report-abuse` action, the web Report button and
// convex/abuseReports.ts share. It lives here, in a module every client already loads, so no client grows a module.
export const ABUSE_REASON_CHARACTERS = 1_000;
const targetRef = z.string().min(1).max(200);

export const abuseReportInputSchema = z
  .object({
    target: z
      .enum(['project', 'message', 'comment', 'account'])
      .describe('What you report: this project, a board note or message, an Item comment, or an account.'),
    messageId: targetRef.optional().describe('target message: the board note or coordination message id.'),
    planningItemId: targetRef.optional().describe('target comment: the Item the comment is on (full id).'),
    id: targetRef.optional().describe('Alias for planningItemId (Item).'),
    itemId: targetRef.optional().describe('Alias for planningItemId (Item).'),
    commentId: targetRef.optional().describe('target comment: the comment id.'),
    handle: z
      .string()
      .regex(/^@?[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/)
      .optional()
      .describe('target account: the Forge handle.'),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(ABUSE_REASON_CHARACTERS)
      .describe('What is wrong, in your words. Only the Forge operator reads it.'),
  })
  .strict()
  .superRefine((input, issues) => {
    const need = (field: 'messageId' | 'planningItemId' | 'commentId' | 'handle') => {
      if (
        (field === 'planningItemId' ? (input.planningItemId ?? input.id ?? input.itemId) : input[field]) ===
        undefined
      )
        issues.addIssue({ code: 'custom', path: [field], message: `target ${input.target} needs ${field}` });
    };
    if (input.target === 'message') need('messageId');
    if (input.target === 'comment') for (const field of ['planningItemId', 'commentId'] as const) need(field);
    if (input.target === 'account') need('handle');
  });
export type AbuseReportInput = z.infer<typeof abuseReportInputSchema>;

export const hostedRecordCommands = {
  friction: frictionInputSchema.omit({ operationId: true }).strict(),
  'friction-list': frictionListSchema,
  // The Issue a planned record points at: a full id or a unique 8+ hex prefix, resolved by the CLI.
  // frictionRef is the same id-or-prefix rule as planning ids, from a module this file already loads.
  'friction-triage': hostedFrictionTriageSchema.extend({
    planningItemId: frictionRef.describe('Issue a planned record points at.').optional(),
    id: frictionRef.describe('Alias for planningItemId (Issue).').optional(),
    itemId: frictionRef.describe('Alias for planningItemId (Issue).').optional(),
  }),
  decide: decideInputSchema.omit({ operationId: true }).strict(),
  decisions: decisionsInputSchema.extend({ cursor: z.string().nullable().default(null) }).strict(),
  /** Report abuse (Item b6588425): to the Forge operator, not to the project. */
  'report-abuse': abuseReportInputSchema,
};
export const hostedImportPageSchema = z
  .object({
    friction: z.array(frictionEventSchema).max(100).default([]),
    decisions: z.array(decisionRecordSchema).max(100).default([]),
  })
  .refine(page => page.friction.length + page.decisions.length <= 100);
