// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Glyph, Key, Menu, Region } from '../../ds';
import { SafeMarkdown } from '../../ds/markdown';
import { age } from '../../ui/status';
import { planningLineEvidence } from '../../../../src/planning-line-evidence';
import { A } from '../frames';
import { navigate } from '../router';
import { writer, type DiscussionComment } from '../discussion/model';
import { EditDraft } from './ItemDraft';
import { itemBody, movedTo, type ItemLine } from './item-body';
import type { FullItem } from './batch';
import type { ItemEdits, LineAction } from './item-edit';
import { DoneWhen } from './rows';

function ItemProse({ text, itemId }: { text: string; itemId: string }) {
  const id = useId();
  const prose = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(0);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const box = prose.current;
    if (!box) return;
    const md = box.firstElementChild as HTMLElement;
    const measure = () => {
      const line = Number.parseFloat(getComputedStyle(md).lineHeight);
      setMore(Math.ceil(Math.max(0, md.offsetHeight - 12 * line - 1) / line));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(md);
    return () => observer.disconnect();
  }, [text]);
  return (
    <div className="ip-text">
      <div
        id={id}
        ref={prose}
        className={more > 0 && !open ? 'ip-cut' : undefined}
        dir="auto"
        onFocusCapture={() => setOpen(true)}
      >
        <SafeMarkdown text={text} idPrefix={`item-${itemId}`} />
      </div>
      {more > 0 ? (
        <Key size="sm" kind="ghost" aria-controls={id} aria-expanded={open} onClick={() => setOpen(!open)}>
          {open
            ? 'Show less text'
            : `Show all text · ${more.toLocaleString()} more ${more === 1 ? 'line' : 'lines'}`}
        </Key>
      ) : null}
    </div>
  );
}

function Evidence({ comment }: { comment?: DiscussionComment | undefined }) {
  const by = comment ? writer(comment) : null;
  const receipt = comment?.text.match(/\b(?:landing|receipt)\s+([\da-f]{8})(?:-[\da-f-]{28})?\b/i)?.[1];
  const search = new URLSearchParams(location.search);
  search.set('comments', 'decisions');
  search.delete('findings');
  search.delete('commentAuthor');
  const href = `${location.pathname}?${search}#${comment ? `comment-${comment.id}` : 'discussion'}`;
  return (
    <>
      {receipt ? `Ticked by reported landing ${receipt}` : 'Ticked'}
      {comment ? (
        <>
          {' '}
          <time dateTime={comment.at} title={new Date(comment.at).toLocaleString()}>
            {age(comment.at, Date.now())}
          </time>
        </>
      ) : null}
      {by?.label && by.verified ? ` by ${by.label}` : ''}
      {receipt ? '' : ' · landing not reported'} ·{' '}
      <a
        className="lk"
        href={href}
        onClick={event => {
          if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
          event.preventDefault();
          navigate(href, { replace: true });
          (
            document.getElementById(comment ? `comment-${comment.id}` : 'discussion') ??
            document.getElementById('discussion')
          )?.scrollIntoView();
        }}
      >
        evidence
      </a>
    </>
  );
}

function DoneLine({
  line,
  item,
  edits,
  evidence,
  href,
}: {
  line: ItemLine;
  item: FullItem;
  edits: ItemEdits;
  evidence?: DiscussionComment | undefined;
  href: (id: string) => string;
}) {
  const { state, text } = line;
  const target = state === 'moved' ? movedTo(text) : null;
  const wording = target ? text.slice(0, target.index) : text;
  const active =
    edits.draft &&
    'line' in edits.draft &&
    edits.draft.line.row === line.row &&
    edits.draft.line.raw === line.raw
      ? edits.draft
      : undefined;
  const start = (kind: LineAction) => {
    const draft = { kind, line, base: item, value: kind === 'wording' ? wording : '' } as const;
    if (kind === 'remove' || kind === 'reopen') void edits.save(draft);
    else edits.reset(draft);
  };
  const editable = edits.canEdit && !edits.draft;
  return (
    <li className={`ip-dw ip-${state}${active ? ' ip-editing' : ''}`}>
      <span className="ip-box" aria-hidden="true">
        {state === 'done' ? (
          <Glyph of="passed" size={11} />
        ) : state === 'moved' ? (
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 8h8M9 5l3 3-3 3" />
          </svg>
        ) : null}
      </span>
      {state === 'open' && editable ? (
        <button className="ip-line ip-line-key" type="button" dir="auto" onClick={() => start('wording')}>
          {wording || 'Untitled line'}
        </button>
      ) : (
        <span className="ip-line" dir="auto">
          {wording}
        </span>
      )}
      <span className="ip-acts">
        {state !== 'open' || !editable ? (
          <span className="ip-word st" data-st={state === 'done' ? 'passed' : 'stale'}>
            <Glyph of={state === 'done' ? 'passed' : state === 'open' ? 'planned' : 'stale'} />
            {state === 'done' ? 'Done' : state === 'moved' ? 'Moved' : 'Open'}
          </span>
        ) : (
          <Key size="sm" onClick={() => start('tick')}>
            Tick…
          </Key>
        )}
        {editable ? (
          <Menu
            label={`More for Done-when line ${line.position}`}
            className="btn ghost sm"
            items={[
              { id: 'wording', label: 'Edit wording', onAction: () => start('wording') },
              ...(state === 'open'
                ? [{ id: 'move', label: 'Mark moved…', onAction: () => start('move') }]
                : [{ id: 'reopen', label: 'Reopen', onAction: () => start('reopen') }]),
              { id: 'remove', label: 'Remove line', danger: true, onAction: () => start('remove') },
            ]}
          >
            ⋯
          </Menu>
        ) : null}
      </span>
      {state !== 'open' ? (
        <span className="ip-src">
          {state === 'moved' ? (
            <>
              {target ? (
                <>
                  to{' '}
                  <A className="lk" href={href(target.id)}>
                    Item {target.id.slice(0, 8)}
                  </A>{' '}
                  ·{' '}
                </>
              ) : null}
              not counted
            </>
          ) : (
            <Evidence comment={evidence} />
          )}
        </span>
      ) : null}
      {active ? <EditDraft edits={edits} draft={active} /> : null}
    </li>
  );
}

export function ItemBody({
  item,
  comments,
  edits,
  href,
}: {
  item: FullItem;
  comments: readonly DiscussionComment[];
  edits: ItemEdits;
  href: (id: string) => string;
}) {
  const { lines, text, scattered } = useMemo(() => itemBody(item.body), [item.body]);
  const evidence = useMemo(() => {
    const index = new Map<string, DiscussionComment>();
    for (const comment of comments)
      if (comment.decision && comment.line) {
        const key = `${comment.line.position}:${comment.line.digest}`;
        if ((index.get(key)?.at ?? '') <= comment.at) index.set(key, comment);
      }
    return index;
  }, [comments]);
  const moved = lines.filter(line => line.state === 'moved').length;
  const done = lines.filter(line => line.state === 'done').length;
  const total = lines.length - moved;
  const { draft, reset, canEdit } = edits;
  const detached =
    draft &&
    'line' in draft &&
    !lines.some(line => line.row === draft.line.row && line.raw === draft.line.raw);
  return (
    <>
      <Region
        title="Text"
        hint={`version ${item.version}${item.at ? ` · edited ${age(item.at, Date.now())}` : ''}${item.author ? ` by ${item.agent ? `${item.author}/${item.agent}` : `@${item.author}`}` : ''}`}
        tools={
          canEdit && !draft ? (
            <Key
              size="sm"
              onClick={() => reset({ kind: 'text', value: scattered ? item.body : text, base: item })}
            >
              Edit text
            </Key>
          ) : null
        }
      >
        {draft?.kind === 'text' ? (
          <EditDraft edits={edits} draft={draft} />
        ) : text ? (
          <ItemProse text={text} itemId={item.id} />
        ) : (
          <div className="quietline">Nothing written yet.</div>
        )}
      </Region>
      <Region
        title="Done when"
        hint={
          <>
            <DoneWhen counts={[done, total]} /> in the Item’s own order{moved ? ` · ${moved} moved` : ''}
          </>
        }
      >
        {lines.length ? (
          <ol className="ip-lines">
            {lines.map(line => (
              <DoneLine
                key={line.row}
                line={line}
                item={item}
                edits={edits}
                href={href}
                evidence={
                  line.state === 'done'
                    ? evidence.get(
                        `${line.position}:${planningLineEvidence(line.position, line.text).digest}`,
                      )
                    : undefined
                }
              />
            ))}
          </ol>
        ) : (
          <div className="quietline">No Done-when lines yet.</div>
        )}
        {canEdit && (draft?.kind === 'add' || detached || !draft) ? (
          <EditDraft edits={edits} draft={draft ?? { kind: 'add', value: '', base: item }} />
        ) : null}
      </Region>
    </>
  );
}
