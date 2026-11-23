// SPDX-License-Identifier: Apache-2.0
// An Item's comments (Item 9a3d6f5f; the approved Item screen's Comments section): threads with their replies, member
// Markdown drawn safely, reactions on comments, and one composer that can also record a decision in the Item body.
// Data comes in as props, so the Item screen (Item d3357f40) decides how it reads; useDiscussion.ts wires the hosted
// reads and writes. Who wrote a comment is the server-recorded account by public identity only (Item 2fb69177): `@handle`
// and "person", or `handle/run`, "agent" and the model its session declared; an older typed label is marked as not
// verified. An agent's words sit behind a thin rule (DESIGN.md rule 33), so the two kinds read apart.
import { useContext, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Band, DockPerson, Key, Menu } from '../../ds';
import type { Id } from '../../../../convex/_generated/dataModel';
import { ReportKey } from '../ReportKey';
import type { ReportTarget } from '../ReportAbuse';
import { By } from './By';
import { ConversationEntry } from './ConversationEntry';
import type { Answer, ThreadEntry } from './conversation';
import type { WhoProject } from '../who-links';
import { SafeMarkdown } from '../../ds/markdown';
import { readReview, ReviewFindings } from './ReviewFindings';
import {
  MAX_COMMENT_CHARACTERS,
  latest,
  reactionGlyph,
  reactionKinds,
  reactionName,
  reactionsFor,
  threads,
  when,
  writer,
  type DiscussionComment,
  type ReactionCount,
  type ReactionKind,
} from './model';
import './discussion.css';

export type PostInput = { text: string; replyTo?: string; decision?: boolean };
export type DiscussionProps = {
  comments: readonly DiscussionComment[];
  reactions?: readonly ReactionCount[];
  /** The viewer may comment and react (the project's planning writers). */
  canWrite: boolean;
  /** More comments are still being read; the count says so instead of looking final. */
  loading?: boolean;
  /** Reads the next page of earlier comments; absent once every comment is read. */
  loadEarlier?: (() => void) | undefined;
  loadingEarlier?: boolean;
  /** A comment page failed to read; what was read stays shown. */
  commentsFailed?: boolean;
  onPost?: (input: PostInput) => Promise<void>;
  onReact?: (commentId: string, kind: ReactionKind) => Promise<void>;
  /** Threads shown before "Show earlier" (the latest ones). */
  pageSize?: number;
  now?: Date;
  project?: WhoProject | undefined;
  title?: 'Comments' | 'Thread';
  /** Offers Report on each comment and message (Item b6588425) to a signed-in viewer who did not write it. */
  reportProjectId?: Id<'hostedProjects'> | undefined;
  conversation?: {
    entries: readonly ThreadEntry[];
    loading: boolean;
    loadingMore?: boolean;
    readFailed?: boolean;
    failed?: boolean;
    loadEarlier?: (() => void) | undefined;
    answer: Answer;
  };
};

export function Discussion({
  comments,
  reactions = [],
  canWrite,
  loading = false,
  loadEarlier,
  loadingEarlier = false,
  commentsFailed = false,
  onPost,
  onReact,
  pageSize = 20,
  now = new Date(),
  project,
  title = 'Comments',
  conversation,
  reportProjectId,
}: DiscussionProps) {
  const report = reportProjectId ? { reportProjectId } : {};
  const all = threads([
    ...comments,
    ...(conversation?.entries.map((row): DiscussionComment => ({
      id: row.id,
      itemId: '',
      text: row.text,
      at: new Date(row.at).toISOString(),
      ...(row.actor ? { author: row.actor } : {}),
      ...(row.agent ? { agent: row.agent } : {}),
      ...(row.replyTo ? { replyTo: row.replyTo } : {}),
      conversation: row,
    })) ?? []),
  ]);
  const pending = all.filter(({ root }) => {
    const row = root.conversation;
    return row?.type === 'question' && !row.answer && !row.ahead && !row.ended;
  });
  // Comments and the conversation are paged apart, newest first. While either has earlier pages, a thread older than
  // the oldest entry that stream has read could sit before unread newer ones, so it waits until both reach it, unless
  // it has a reply past that point.
  const oldest = (times: string[]) => (times.length ? times.reduce((a, b) => (a < b ? a : b)) : '');
  const frontier = [
    loadEarlier ? oldest(comments.map(comment => comment.at)) : '',
    conversation?.loadEarlier ? oldest(conversation.entries.map(row => new Date(row.at).toISOString())) : '',
  ].reduce((a, b) => (a > b ? a : b), '');
  const recent = all.filter(
    thread =>
      !pending.includes(thread) && [thread.root, ...thread.replies].some(comment => comment.at >= frontier),
  );
  const anchor = useRef<HTMLElement>(null);
  useEffect(() => {
    if (location.hash !== '#discussion') return;
    anchor.current?.scrollIntoView();
    anchor.current?.focus({ preventScroll: true });
  }, []);
  const [shown, setShown] = useState(pageSize);
  const [replying, setReplying] = useState<string | null>(null);
  const { visible, earlier } = latest(recent, shown);
  const total = comments.length + (conversation?.entries.length ?? 0);
  const reading = loading || conversation?.loading;
  const earlierMessages = conversation?.loadEarlier;
  const more =
    earlierMessages || loadEarlier
      ? () => {
          earlierMessages?.();
          loadEarlier?.();
        }
      : undefined;
  const loadingMore = conversation?.loadingMore || loadingEarlier;
  const conversationActions = conversation ? { answer: conversation.answer } : {};
  return (
    <section className="sec discussion" id="discussion" aria-label={title} ref={anchor} tabIndex={-1}>
      <Band
        title={title}
        count={total}
        hint={
          reading || more
            ? reading
              ? 'reading the rest…'
              : 'loaded so far'
            : all.length !== total
              ? `${all.length} ${all.length === 1 ? 'thread' : 'threads'}`
              : undefined
        }
      />
      {pending.map(({ root, replies }) => (
        <div key={root.id} className="thread-of" data-pinned="">
          <Comment
            comment={root}
            reactions={[]}
            canWrite={false}
            now={now}
            project={project}
            {...conversationActions}
            {...report}
          />
          {replies.map(reply => (
            <Comment
              key={reply.id}
              comment={reply}
              reply
              reactions={[]}
              canWrite={false}
              now={now}
              project={project}
              {...conversationActions}
              {...report}
            />
          ))}
        </div>
      ))}
      {earlier || more || loadingMore ? (
        <div className="quietline">
          {earlier ? (
            <>
              Showing the latest {visible.length} of {recent.length} threads.{' '}
            </>
          ) : null}
          <Key
            size="sm"
            aria-disabled={loadingMore}
            aria-busy={loadingMore}
            onClick={() => {
              if (loadingMore) return;
              if (earlier < pageSize) more?.();
              setShown(value => value + pageSize);
            }}
          >
            {loadingMore
              ? 'Loading earlier…'
              : `Show ${more ? pageSize : Math.min(pageSize, earlier)} earlier`}
          </Key>
          {conversation?.failed ? <p role="alert">Could not read earlier messages. Try again.</p> : null}
          {commentsFailed ? (
            <p role="alert">Could not read earlier comments. Reload the page to try again.</p>
          ) : null}
        </div>
      ) : null}
      {conversation?.readFailed ? (
        <p className="quietline" role="alert">
          Could not load the conversation.
        </p>
      ) : null}
      {!total && !reading && !conversation?.readFailed ? (
        <p className="quietline">{title === 'Thread' ? 'No messages yet.' : 'No comments yet.'}</p>
      ) : null}
      {visible.map(thread => (
        <div key={thread.root.id} className="thread-of">
          <Comment
            comment={thread.root}
            reactions={reactions}
            canWrite={canWrite}
            now={now}
            project={project}
            {...conversationActions}
            {...report}
            {...(onReact ? { onReact } : {})}
            {...(canWrite && onPost && !thread.root.system && !thread.root.conversation
              ? { onReply: () => setReplying(thread.root.id) }
              : {})}
          />
          {thread.replies.map(reply => (
            <Comment
              key={reply.id}
              comment={reply}
              reply
              reactions={reactions}
              canWrite={canWrite}
              now={now}
              project={project}
              {...conversationActions}
              {...report}
              {...(onReact ? { onReact } : {})}
            />
          ))}
          {replying === thread.root.id && onPost ? (
            <Composer
              reply
              onPost={input => onPost({ ...input, replyTo: thread.root.id }).then(() => setReplying(null))}
              onCancel={() => setReplying(null)}
            />
          ) : null}
        </div>
      ))}
      {canWrite && onPost ? <Composer onPost={onPost} /> : null}
    </section>
  );
}

function Comment({
  comment,
  reply = false,
  reactions,
  canWrite,
  now,
  project,
  onReact,
  onReply,
  answer,
  reportProjectId,
}: {
  comment: DiscussionComment;
  reply?: boolean;
  reactions: readonly ReactionCount[];
  canWrite: boolean;
  now: Date;
  project?: WhoProject | undefined;
  onReact?: (commentId: string, kind: ReactionKind) => Promise<void>;
  onReply?: () => void;
  answer?: Answer;
  reportProjectId?: Id<'hostedProjects'> | undefined;
}) {
  const by = writer(comment);
  const row = comment.conversation;
  const viewer = useContext(DockPerson);
  // Report is for what someone else wrote; a Forge-written note has no writer to report.
  const reportable =
    reportProjectId && viewer && !comment.system && (row ? row.actor : comment.author) !== viewer;
  const reportTarget: ReportTarget | null = !reportable
    ? null
    : row
      ? { target: 'message', messageId: row.id }
      : { target: 'comment', planningItemId: comment.itemId, commentId: comment.id };
  const review = row ? null : readReview(comment.text);
  const counts = row ? [] : reactionsFor(reactions, comment.id);
  // A system note (a landing receipt) takes no reaction or reply: nobody wrote it.
  const react =
    canWrite && onReact && !comment.system && !row
      ? (kind: ReactionKind) => void onReact(comment.id, kind)
      : undefined;
  return (
    <article className={`cmt${reply ? ' re' : ''}`} id={`comment-${comment.id}`} data-kind={by.kind}>
      <div className="by">
        <By by={by} project={project} />
        <time dateTime={comment.at} title={comment.at}>
          {when(comment.at, now)}
        </time>
        {row?.type === 'question' ? (
          <span className="chip">
            <span>{row.answer || row.ended ? 'Question' : row.ahead ? 'Asked ahead' : 'Open question'}</span>
          </span>
        ) : row?.type === 'hand-back' || row?.type === 'handoff' ? (
          <span className="chip">
            <span>{row.type === 'hand-back' ? 'Handed back' : 'Handoff'}</span>
          </span>
        ) : null}
        {comment.decision ? (
          <span className="chip" title="Kept in the Item body, with its date">
            <span>Decision</span>
          </span>
        ) : null}
      </div>
      {row && (row.type !== 'note' || row.withdrawnAt !== undefined) ? (
        <ConversationEntry row={row} project={project} {...(answer ? { answer } : {})} />
      ) : comment.text.length > MAX_COMMENT_CHARACTERS ? (
        <p className="quietline">
          This comment is longer than {MAX_COMMENT_CHARACTERS.toLocaleString('en-US')} characters and is not
          shown.
        </p>
      ) : review ? (
        <ReviewFindings review={review} original={comment.text} />
      ) : (
        <SafeMarkdown text={comment.text} idPrefix={comment.id} />
      )}
      {counts.length || react || onReply || reportTarget ? (
        <div className="acts">
          {counts.map(entry => (
            <button
              key={entry.kind}
              type="button"
              className={`react${entry.mine ? ' on' : ''}`}
              aria-pressed={entry.mine}
              aria-label={`${reactionName[entry.kind]}: ${entry.count}${entry.mine ? ', yours' : ''}`}
              disabled={!react}
              onClick={() => react?.(entry.kind)}
            >
              <span aria-hidden="true">{reactionGlyph[entry.kind]}</span>
              <span className="num">{entry.count}</span>
            </button>
          ))}
          {react ? (
            <Menu
              label="React to this comment"
              className="btn sm ghost"
              focusKey={`react-${comment.id}`}
              items={reactionKinds.map(kind => ({
                id: kind,
                label: `${reactionGlyph[kind]} ${reactionName[kind]}`,
                onAction: () => react(kind),
              }))}
            >
              React
            </Menu>
          ) : null}
          {onReply ? (
            <Key size="sm" kind="ghost" onClick={onReply}>
              Reply
            </Key>
          ) : null}
          {reportTarget ? <ReportKey projectId={reportProjectId} target={reportTarget} /> : null}
        </div>
      ) : null}
    </article>
  );
}

function Composer({
  reply = false,
  onPost,
  onCancel,
}: {
  reply?: boolean;
  onPost: (input: PostInput) => Promise<void>;
  onCancel?: () => void;
}) {
  const id = useId();
  const box = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [decision, setDecision] = useState(false);
  const [state, setState] = useState<'idle' | 'sending' | 'failed'>('idle');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim() || state === 'sending') return;
    setState('sending');
    try {
      await onPost({ text, ...(decision ? { decision: true } : {}) });
      setText('');
      setDecision(false);
      setState('idle');
    } catch {
      // The text stays in the box, so nothing typed is lost.
      setState('failed');
    }
  };
  return (
    <form className={`cmt compose${reply ? ' re' : ''}`} onSubmit={submit}>
      <label className="sr" htmlFor={id}>
        {reply ? 'Reply' : 'Comment'}
      </label>
      <textarea
        ref={box}
        className="inp"
        id={id}
        name="comment"
        rows={2}
        autoComplete="off"
        maxLength={MAX_COMMENT_CHARACTERS}
        autoFocus={reply}
        placeholder={reply ? 'Reply…' : 'Comment, or record evidence. Markdown works…'}
        value={text}
        onChange={event => setText(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submit(event);
          if (event.key === 'Escape' && onCancel) onCancel();
        }}
        aria-describedby={state === 'failed' ? `${id}-failed` : undefined}
      />
      <div className="btns">
        <Key size="sm" type="submit" disabled={!text.trim() || state === 'sending'} keys="⌘↵">
          {state === 'sending' ? 'Sending…' : reply ? 'Reply' : 'Comment'}
        </Key>
        {onCancel ? (
          <Key size="sm" kind="ghost" onClick={onCancel}>
            Cancel
          </Key>
        ) : null}
        {reply ? null : (
          <label className="t2 decide">
            <input type="checkbox" checked={decision} onChange={event => setDecision(event.target.checked)} />
            This is a decision: keep it in the body, with today’s date
          </label>
        )}
      </div>
      {state === 'failed' ? (
        <p className="err" id={`${id}-failed`} role="alert">
          Not sent. Your text is still here; try again.
        </p>
      ) : null}
    </form>
  );
}
