// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { getPage, type IndexKey } from 'convex-helpers/server/pagination';
import { v, type Infer } from 'convex/values';
import { query } from './cliServer';
import type { Doc } from './_generated/dataModel';
import { eventByOperation, openLaneForCoordination, receipt, session } from './coordinationWrite';
import { accessibleProject } from './projectAuthority';
import { hasWriteRole } from './projectRole';
import { isAgentSlug } from '../src/agent-slug';
import { invariant } from '../src/errors';
import { report } from './errors';
import schema from './schema';

const limit = 20;
const key = v.array(v.union(v.number(), v.string()));
const positions = v.object({
  note: v.optional(key),
  message: v.optional(key),
  handoff: v.optional(key),
  intentMessage: v.optional(key),
});
const entry = v.object({
  id: v.string(),
  at: v.number(),
  actor: v.string(),
  agent: v.optional(v.string()),
  type: v.union(v.literal('note'), v.literal('question'), v.literal('handoff'), v.literal('hand-back')),
  text: v.string(),
  replyTo: v.optional(v.string()),
  withdrawnAt: v.optional(v.number()),
  choices: v.optional(v.array(v.string())),
  ahead: v.optional(v.boolean()),
  ended: v.optional(v.literal(true)),
  mayAnswer: v.optional(v.boolean()),
  head: v.optional(v.string()),
  left: v.optional(v.string()),
  to: v.optional(v.string()),
  answer: v.optional(
    v.object({
      choice: v.string(),
      text: v.string(),
      actor: v.optional(v.string()),
      resumePrompt: v.optional(v.string()),
      seenAt: v.optional(v.number()),
      agent: v.optional(v.string()),
      lastActivity: v.optional(v.number()),
    }),
  ),
});
type Source = keyof Infer<typeof positions>;
type Position = Infer<typeof positions>;
const result = v.object({
  canRead: v.boolean(),
  entries: v.array(entry),
  before: v.union(positions, v.null()),
});
type Event = Doc<'projectCoordinationEvents'>;

/** One window over the two retained sources. Each continuation advances only roots returned to the reader. */
export const read = query({
  args: {
    projectId: v.id('hostedProjects'),
    scope: v.union(v.literal('lane'), v.literal('item')),
    id: v.string(),
    before: v.optional(positions),
  },
  returns: result,
  handler: async (ctx, { projectId, scope, id, before }): Promise<Infer<typeof result>> => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read the thread.');
      const project = await accessibleProject(ctx, projectId, user.subject);
      if (!(await hasWriteRole(ctx, project, user.subject)))
        return { canRead: false, entries: [], before: null };
      invariant(
        Object.values(before ?? {}).every(
          part =>
            part.length === 3 &&
            typeof part[0] === 'number' &&
            typeof part[1] === 'number' &&
            typeof part[2] === 'string',
        ),
        'BAD_ARGUMENT',
        'Use a thread continuation from this page.',
      );
      function bounds(source: Source, prefix: IndexKey) {
        const prior = before?.[source];
        return {
          schema,
          order: 'desc' as const,
          startIndexKey: [...prefix, ...(prior ?? [])],
          startInclusive: prior === undefined,
          endIndexKey: prefix,
          endInclusive: true,
          targetMaxRows: limit,
          absoluteMaxRows: limit,
        };
      }
      const events = (kind: 'message' | 'handoff') =>
        getPage(ctx, {
          table: 'projectCoordinationEvents',
          index:
            scope === 'lane'
              ? 'by_project_and_kind_and_laneId_and_at'
              : 'by_project_and_kind_and_planningItemId_and_at',
          ...bounds(kind, [projectId, kind, id]),
        });
      const legacyIntentMessages = () =>
        getPage(ctx, {
          table: 'projectCoordinationEvents',
          index: 'by_project_and_kind_and_intentId_and_laneId_and_at',
          // The classic Item screen sent a message on its Intent. Messages scoped
          // to a Lane stay on that Lane even when the sender also supplied an Intent.
          ...bounds('intentMessage', [projectId, 'message', id, undefined]),
        });
      const [notes, messages, open, other] = await Promise.all([
        getPage(ctx, {
          table: 'projectBoardMessages',
          index: 'by_project_and_target_and_at',
          ...bounds('note', [projectId, `${scope === 'item' ? 'issue' : 'lane'}:${id}`]),
        }),
        events('message'),
        scope === 'lane' ? openLaneForCoordination(ctx, projectId, id) : true,
        scope === 'lane' ? events('handoff') : legacyIntentMessages(),
      ] as const);
      const roots = [
        ...notes.page.map((row, i) => ({
          source: 'note' as const,
          row,
          key: notes.indexKeys[i]!.slice(2) as (number | string)[],
        })),
        ...messages.page.map((row, i) => ({
          source: 'message' as const,
          row,
          key: messages.indexKeys[i]!.slice(3) as (number | string)[],
        })),
        ...other.page.map((row, i) => ({
          source: scope === 'lane' ? ('handoff' as const) : ('intentMessage' as const),
          row,
          key: other.indexKeys[i]!.slice(scope === 'lane' ? 3 : 4) as (number | string)[],
        })),
      ].sort(
        (a, b) =>
          b.row.at - a.row.at ||
          b.row._creationTime - a.row._creationTime ||
          (a.row._id < b.row._id ? 1 : -1),
      );
      const next: Position = { ...before };
      const sessions = new Map<string, ReturnType<typeof session>>();
      const observed = (id: string | undefined) => {
        if (!id) return null;
        let row = sessions.get(id);
        if (!row) {
          row = session(ctx, projectId, id);
          sessions.set(id, row);
        }
        return row;
      };
      const agentName = (row: Awaited<ReturnType<typeof session>>) =>
        row?.kind !== 'person' && isAgentSlug(row?.name) ? { agent: row.name } : {};
      async function answerOf(row: Event) {
        if (!row.recipientActor) return;
        const ack = await receipt(ctx, projectId, row.operationId, row.recipientActor);
        if (!ack?.choice) return;
        const saved = await eventByOperation(ctx, projectId, ack.ackId);
        const seen = saved?.resumePrompt ? await receipt(ctx, projectId, saved.operationId, row.actor) : null;
        const senderSession =
          row.command.kind === 'message' || row.command.kind === 'handoff'
            ? row.command.sessionId
            : undefined;
        const sender = await observed(seen?.sessionId ?? senderSession);
        return {
          choice: ack.choice,
          actor: ack.actor,
          text: saved?.command.kind === 'ack' ? saved.command.text : '',
          ...(saved?.resumePrompt ? { resumePrompt: saved.resumePrompt } : {}),
          ...(seen ? { seenAt: seen.at } : {}),
          ...agentName(sender),
          ...(sender ? { lastActivity: sender.lastActivity ?? sender.lastSeen } : {}),
        };
      }
      const entries = await Promise.all(
        roots.slice(0, limit).map(async root => {
          next[root.source] = root.key;
          const { at } = root.row;
          if (root.source === 'note') {
            const { row } = root;
            return {
              id: row.id,
              at,
              actor: row.author,
              ...(row.agent ? { agent: row.agent } : {}),
              type: 'note' as const,
              text: row.body,
              ...(row.replyTo ? { replyTo: row.replyTo } : {}),
              ...(row.resolvedAt ? { withdrawnAt: row.resolvedAt } : {}),
            };
          }
          const { row } = root;
          const { command } = row;
          if (command.kind !== 'message' && command.kind !== 'handoff') return null;
          const base = {
            id: row.operationId,
            at,
            actor: row.actor,
            ...agentName(await observed(command.sessionId)),
          };
          const mayAnswer = open && row.recipientActor === user.subject;
          if (command.kind === 'handoff') {
            const answer = command.handBack ? await answerOf(row) : undefined;
            return {
              ...base,
              type: command.handBack ? ('hand-back' as const) : ('handoff' as const),
              head: command.head,
              text: command.summary,
              left: command.handBack?.left ?? '',
              ...(row.recipientActor ? { to: row.recipientActor } : {}),
              ...(answer ? { answer } : {}),
              mayAnswer: Boolean(command.handBack && mayAnswer && !answer),
            };
          }
          const choices = command.choices ?? [];
          const answer = choices.length ? await answerOf(row) : undefined;
          return {
            ...base,
            type: choices.length ? ('question' as const) : ('note' as const),
            text: command.text,
            ...(choices.length
              ? { choices, ahead: command.question?.holdsWork === false, mayAnswer: mayAnswer && !answer }
              : {}),
            ...(!open && choices.length ? { ended: true as const } : {}),
            ...(answer ? { answer } : {}),
          };
        }),
      );
      return {
        canRead: true,
        entries: entries.filter(row => row !== null),
        before: roots.length > limit || notes.hasMore || messages.hasMore || other.hasMore ? next : null,
      };
    } catch (error) {
      return report(error);
    }
  },
});
