// SPDX-License-Identifier: Apache-2.0
// An Item's discussion as the screen draws it (Item 9a3d6f5f): threads in the order they started, each reply under its
// root, who wrote each comment by public identity only, and the reaction counts beside it.

/** A planning comment row as public reads return it: `author` is already the writer's Forge handle (or gone for a
 * reader who may not see people); `agent` is the writing agent session's slug. */
export type DiscussionComment = {
  id: string;
  itemId: string;
  text: string;
  at: string;
  authorLabel?: string;
  author?: string;
  agent?: string;
  /** The agent session's declared client, `tool` or `tool:model` (declared, never verified). */
  agentClient?: string;
  replyTo?: string;
  decision?: true;
};
export type Thread = { root: DiscussionComment; replies: DiscussionComment[] };

/** The reactions a comment can get: GitHub's eight, by name. Stars are for projects only. */
export const reactionKinds = ['+1', '-1', 'laugh', 'hooray', 'confused', 'heart', 'rocket', 'eyes'] as const;
export type ReactionKind = (typeof reactionKinds)[number];
export const reactionGlyph: Record<ReactionKind, string> = {
  '+1': '👍',
  '-1': '👎',
  laugh: '😄',
  hooray: '🎉',
  confused: '😕',
  heart: '❤️',
  rocket: '🚀',
  eyes: '👀',
};
export const reactionName: Record<ReactionKind, string> = {
  '+1': 'thumbs up',
  '-1': 'thumbs down',
  laugh: 'laugh',
  hooray: 'hooray',
  confused: 'confused',
  heart: 'heart',
  rocket: 'rocket',
  eyes: 'eyes',
};
export type ReactionCount = { commentId: string; kind: ReactionKind; count: number; mine: boolean };

const handle = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const slug = /^[a-z]{2,10}-[a-z]{2,10}$/;
/** A receipt's agent client (src/agent-slug.ts AGENT_CLIENT): `tool` or `tool:model`. */
const clientShape = /^[a-z][a-z0-9-]{0,31}(?::[A-Za-z0-9][A-Za-z0-9._/-]{0,63})?$/;
const legacyLabel = /^@?([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?(?:\/[a-z]{2,10}-[a-z]{2,10})?)$/;

/** The longest comment a hosted project stores (convex/planningCommentWriter.ts); longer text is never drawn. */
export const MAX_COMMENT_CHARACTERS = 65_536;

/** Who wrote a comment, as the design's "who did it": a person (`@handle`) or an agent run (`handle/run`) with the model
 * its session declared. `verified` is the server-recorded account. A reader who may not see people gets no account
 * from the server (convex/publicPeople.ts), so the comment still says whether a person or an agent run wrote it, with
 * the run name only. An older comment's typed label shows only when it has the shape of a public identity, marked as
 * not verified, so a typed label can never pass for a writer the server checked. */
export type Writer = {
  /** `forge`: a Forge job wrote it (a system actor, never an account). */
  kind: 'person' | 'agent' | 'forge';
  /** `@handle`, `handle/run`, or the run alone when the person is hidden; '' when no one may be named. */
  label: string;
  /** The declared model, or null for an agent that declared none (a person has none). */
  model: string | null;
  verified: boolean;
};
const modelOf = (client: string | undefined) => {
  const model = client && clientShape.test(client) ? client.split(':')[1] : undefined;
  return model ?? null;
};
export function writer(comment: DiscussionComment): Writer {
  const agent = comment.agent && slug.test(comment.agent) ? comment.agent : undefined;
  const model = agent ? modelOf(comment.agentClient) : null;
  if (comment.author && handle.test(comment.author))
    return agent
      ? { kind: 'agent', label: `${comment.author}/${agent}`, model, verified: true }
      : { kind: 'person', label: `@${comment.author}`, model: null, verified: true };
  // System actors ('forge:expiry', 'landing controller') are never accounts and never hidden.
  if (comment.author && /[\s:]/.test(comment.author))
    return { kind: 'forge', label: 'Forge', model: null, verified: true };
  // The server records the writer on every hosted comment; with no account here the person is hidden from this reader.
  if (agent) return { kind: 'agent', label: agent, model, verified: true };
  const typed = legacyLabel.exec(comment.authorLabel?.trim() ?? '');
  if (typed)
    return {
      kind: typed[1]!.includes('/') ? 'agent' : 'person',
      label: typed[1]!,
      model: null,
      verified: false,
    };
  return { kind: 'person', label: '', model: null, verified: false };
}

/** Threads oldest first, replies oldest first under their root. A reply whose root is not loaded stands alone. */
export function threads(comments: readonly DiscussionComment[]): Thread[] {
  const sorted = [...comments].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  const byId = new Map<string, Thread>();
  const out: Thread[] = [];
  for (const comment of sorted) {
    const root = comment.replyTo ? byId.get(comment.replyTo) : undefined;
    if (root) root.replies.push(comment);
    else {
      const thread = { root: comment, replies: [] };
      byId.set(comment.id, thread);
      out.push(thread);
    }
  }
  return out;
}

/** The latest `shown` threads, and how many earlier ones are folded away, so the count beside the band reconciles. */
export function latest(all: readonly Thread[], shown: number) {
  const from = Math.max(0, all.length - shown);
  return { visible: all.slice(from), earlier: from };
}

export function reactionsFor(counts: readonly ReactionCount[], commentId: string) {
  return reactionKinds
    .map(kind => counts.find(entry => entry.commentId === commentId && entry.kind === kind))
    .filter((entry): entry is ReactionCount => !!entry && entry.count > 0);
}

/** When it was written, short: today's time, or the day and time. */
export function when(at: string, now: Date) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === now.toDateString()) return `today, ${time}`;
  const day = date.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
  return `${day.replace(',', '')}, ${time}`;
}
