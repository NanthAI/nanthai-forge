// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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
import { Attachments, sizeLabel, type ReadAttachment } from './Attachments';
import { ATTACHMENT_LIMITS } from '../../../../src/discussion-attachment-limits';
import { AttachmentProblem, attachmentRefusal } from './attachment-io';
import { readReview, ReviewFindings } from './ReviewFindings';
import { CommentFilters, useCommentFilters } from './CommentFilters';
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

export type PostInput = { text: string; replyTo?: string; decision?: boolean; files?: File[] };
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
  /** Reads one attachment's bytes through the authorized download route; absent, files show by name only. */
  readAttachment?: ReadAttachment;
  /** Threads shown before "Show earlier" (the latest ones). */
  pageSize?: number;
  itemPage?: boolean;
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

export function Discussion(props: DiscussionProps) {
  return props.itemPage ? <ItemComments {...props} /> : <DiscussionContent {...props} />;
}

function ItemComments(props: DiscussionProps) {
  const filters = useCommentFilters();
  return <DiscussionContent {...props} filters={filters} />;
}

function DiscussionContent({
  comments,
  reactions = [],
  canWrite,
  loading = false,
  loadEarlier,
  loadingEarlier = false,
  commentsFailed = false,
  onPost,
  onReact,
  readAttachment,
  pageSize = 20,
  itemPage = false,
  now = new Date(),
  project,
  title = 'Comments',
  conversation,
  reportProjectId,
  filters,
}: DiscussionProps & { filters?: ReturnType<typeof useCommentFilters> }) {
  const report = reportProjectId ? { reportProjectId } : {};
  const matched = filters?.active ? comments.filter(filters.matches) : comments;
  const all = threads([
    ...matched,
    ...((filters?.active ? undefined : conversation)?.entries.map((row): DiscussionComment => ({
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
  const hash = typeof location === 'undefined' ? '' : location.hash;
  useEffect(() => {
    const id = hash.slice(1);
    if (id !== 'discussion' && !id.startsWith('comment-')) return;
    if (id === 'discussion') anchor.current?.focus({ preventScroll: true });
    (document.getElementById(id) ?? anchor.current)?.scrollIntoView();
  }, [hash, filters?.decisions]);
  const [shown, setShown] = useState(pageSize);
  const [replying, setReplying] = useState<string | null>(null);
  const folded = latest(recent, shown);
  // The cursor already bounds Item comments. Another client-side limit would hide loaded filter matches.
  const visible = itemPage ? [...all.filter(thread => !pending.includes(thread))].reverse() : folded.visible;
  const earlier = itemPage ? 0 : folded.earlier;
  const total = comments.length + (conversation?.entries.length ?? 0);
  const reading = loading || conversation?.loading;
  const earlierMessages = conversation?.loadEarlier;
  const more = itemPage
    ? (loadEarlier ?? (!filters?.active ? earlierMessages : undefined))
    : earlierMessages || loadEarlier
      ? () => {
          earlierMessages?.();
          loadEarlier?.();
        }
      : undefined;
  const loadingMore = conversation?.loadingMore || loadingEarlier;
  const conversationActions = conversation ? { answer: conversation.answer } : {};
  return (
    <section
      className={itemPage ? 'region discussion' : 'sec discussion'}
      id="discussion"
      aria-label={title}
      ref={anchor}
      tabIndex={-1}
    >
      {filters ? (
        <>
          <div className="ph plain">
            <h2>{title}</h2>
            <span className="cnt">{comments.length.toLocaleString()}</span>
            <span className="hint">newest first{loadEarlier ? ' · loaded so far' : ''}</span>
          </div>
          <CommentFilters
            filters={filters}
            comments={comments}
            matching={matched.length}
            more={Boolean(loadEarlier || loadingEarlier)}
            loading={Boolean(reading)}
          />
        </>
      ) : (
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
      )}
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
      {!itemPage && (earlier || more || loadingMore) ? (
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
            {...(readAttachment ? { readAttachment } : {})}
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
              {...(readAttachment ? { readAttachment } : {})}
              {...(onReact ? { onReact } : {})}
            />
          ))}
          {replying === thread.root.id && onPost ? (
            <Composer
              reply
              attachable={Boolean(readAttachment)}
              onPost={input => onPost({ ...input, replyTo: thread.root.id }).then(() => setReplying(null))}
              onCancel={() => setReplying(null)}
            />
          ) : null}
        </div>
      ))}
      {canWrite && onPost ? <Composer attachable={Boolean(readAttachment)} onPost={onPost} /> : null}
      {itemPage ? (
        <div className="pager">
          <span className="n">
            {comments.length.toLocaleString()} {comments.length === 1 ? 'comment' : 'comments'} loaded
          </span>
          {more || loadingMore ? (
            <Key
              size="sm"
              aria-busy={loadingMore}
              aria-disabled={!more || loadingMore}
              onClick={() => {
                if (!loadingMore) more?.();
              }}
            >
              {loadingMore ? 'Loading earlier…' : loadEarlier ? 'Show 20 earlier' : 'Show earlier messages'}
            </Key>
          ) : null}
          {commentsFailed ? (
            <span role="alert">
              Could not read {comments.length ? 'earlier ' : ''}comments. Reload the page to try again.
            </span>
          ) : null}
          {conversation?.failed ? <span role="alert">Could not read earlier messages.</span> : null}
        </div>
      ) : null}
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
  readAttachment,
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
  readAttachment?: ReadAttachment;
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
      {!row && comment.attachments?.length ? (
        <Attachments commentId={comment.id} files={comment.attachments} read={readAttachment} />
      ) : null}
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
  attachable = false,
  onPost,
  onCancel,
}: {
  reply?: boolean;
  /** Offers Attach: only where the comment is a planning comment that can carry files. */
  attachable?: boolean;
  onPost: (input: PostInput) => Promise<void>;
  onCancel?: () => void;
}) {
  const id = useId();
  const box = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [decision, setDecision] = useState(false);
  const [state, setState] = useState<'idle' | 'sending' | 'failed'>('idle');
  const [files, setFiles] = useState<File[]>([]);
  const [problem, setProblem] = useState('');
  const picker = useRef<HTMLInputElement>(null);
  const attach = (picked: FileList | null) => {
    const next = [...files, ...(picked ? [...picked] : [])];
    const refused = next.map(attachmentRefusal).find(Boolean);
    setProblem(
      refused ??
        (next.length > ATTACHMENT_LIMITS.perComment
          ? `A comment holds at most ${ATTACHMENT_LIMITS.perComment} files.`
          : ''),
    );
    if (!refused && next.length <= ATTACHMENT_LIMITS.perComment) setFiles(next);
    if (picker.current) picker.current.value = '';
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim() || state === 'sending') return;
    setState('sending');
    setProblem('');
    try {
      await onPost({ text, ...(decision ? { decision: true } : {}), ...(files.length ? { files } : {}) });
      setText('');
      setDecision(false);
      setFiles([]);
      setState('idle');
    } catch (error) {
      // The text and the files stay, so nothing typed or chosen is lost.
      setProblem(error instanceof AttachmentProblem ? error.message : '');
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
        {attachable ? (
          <>
            <input
              ref={picker}
              type="file"
              multiple
              className="sr"
              tabIndex={-1}
              aria-label="Attach files"
              onChange={event => attach(event.target.files)}
            />
            <Key size="sm" kind="ghost" onClick={() => picker.current?.click()}>
              Attach
            </Key>
          </>
        ) : null}
        {reply ? null : (
          <label className="t2 decide">
            <input type="checkbox" checked={decision} onChange={event => setDecision(event.target.checked)} />
            This is a decision: keep it in the body, with today’s date
          </label>
        )}
      </div>
      {files.length ? (
        <ul className="attached" aria-label="Files to attach">
          {files.map((file, at) => (
            <li key={`${file.name}-${file.size}-${at}`}>
              <span>
                {file.name} ({sizeLabel(file.size)})
              </span>
              <Key
                size="sm"
                kind="ghost"
                aria-label={`Remove ${file.name}`}
                onClick={() => setFiles(files.filter((_, index) => index !== at))}
              >
                Remove
              </Key>
            </li>
          ))}
        </ul>
      ) : null}
      {problem && state !== 'failed' ? (
        <p className="err" role="alert">
          {problem}
        </p>
      ) : null}
      {state === 'failed' ? (
        <p className="err" id={`${id}-failed`} role="alert">
          {problem ? `Not sent. ${problem}` : 'Not sent. Your text is still here; try again.'}
        </p>
      ) : null}
    </form>
  );
}
