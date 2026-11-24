// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { Key, Menu } from '../../ds';
import { navigate, useSearch } from '../router';
import { writer, type DiscussionComment } from './model';
import { readReview } from './ReviewFindings';

export function useCommentFilters() {
  const search = useSearch();
  const decisions = search.get('comments') === 'decisions';
  const review = search.get('findings') === 'yes';
  const author = search.get('commentAuthor') ?? '';
  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(location.search);
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    navigate(`${location.pathname}${next.size ? `?${next}` : ''}${location.hash}`, { replace: true });
  };
  return {
    decisions,
    review,
    author,
    set,
    active: Boolean(decisions || review || author),
    clear: () => set({ comments: '', findings: '', commentAuthor: '' }),
    matches: (comment: DiscussionComment) =>
      (!decisions || comment.decision) &&
      (!review || readReview(comment.text)) &&
      (!author || writer(comment).label === author),
  };
}

function Filter({ label, on, toggle }: { label: string; on: boolean; toggle: () => void }) {
  return on ? (
    <span className="chip">
      <span>{label}</span>
      <button type="button" aria-label={`Clear ${label}`} onClick={toggle}>
        ×
      </button>
    </span>
  ) : (
    <button type="button" className="chip off" onClick={toggle}>
      {label} <i>any</i>
    </button>
  );
}

export function CommentFilters({
  filters,
  comments,
  matching,
  more,
  loading,
}: {
  filters: ReturnType<typeof useCommentFilters>;
  comments: readonly DiscussionComment[];
  matching: number;
  more: boolean;
  loading: boolean;
}) {
  const { decisions, review, author, set, active, clear } = filters;
  const authors = [
    ...new Set(
      comments
        .map(writer)
        .filter(by => by.verified && by.label)
        .map(by => by.label),
    ),
  ].sort((a, b) => a.localeCompare(b));
  return (
    <>
      <div className="tbar" role="group" aria-label="Filter comments">
        <Filter
          label="Decisions"
          on={decisions}
          toggle={() => set({ comments: decisions ? '' : 'decisions' })}
        />
        <Filter label="Review findings" on={review} toggle={() => set({ findings: review ? '' : 'yes' })} />
        {author ? (
          <span className="chip">
            <span>Author: {author}</span>
            <button type="button" aria-label="Clear author" onClick={() => set({ commentAuthor: '' })}>
              ×
            </button>
          </span>
        ) : (
          <Menu
            label="Filter comments: Author any"
            className="chip off"
            items={authors.map(label => ({
              id: label,
              label,
              onAction: () => set({ commentAuthor: label }),
            }))}
          >
            Author <i>any</i>
          </Menu>
        )}
        <span className="n" role="status">
          {matching.toLocaleString()} of {comments.length.toLocaleString()} loaded
        </span>
      </div>
      {more && active ? (
        <div className="ip-filterline">
          Filters look at the {comments.length.toLocaleString()} comments loaded so far.
        </div>
      ) : null}
      {active && !loading && !matching ? (
        <div className="quietline">
          No{' '}
          {decisions && !review && !author
            ? 'decisions'
            : review && !decisions && !author
              ? 'review findings'
              : 'matches'}{' '}
          in the {comments.length.toLocaleString()} loaded comments.{' '}
          <Key size="sm" kind="ghost" onClick={clear}>
            Clear filters
          </Key>
        </div>
      ) : null}
    </>
  );
}
