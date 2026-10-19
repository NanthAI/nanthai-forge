// SPDX-License-Identifier: Apache-2.0
import { useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { PagedList, ScaleGroups } from './ScaleList';
import { SCALE_AFTER } from './scale-model';
import { useVisibleDecisions } from '../shell/visible-decisions';
import { Glyph, type GlyphName } from '../ui/Glyph';
import { Avatar, Panel } from '../ui/primitives';
import { age } from '../ui/status';
import { WorkReferenceContext, WorkText } from './WorkReferences';
import type { DecisionItem } from './attention';

const kinds: Record<DecisionItem['kind'], { label: string; glyph: GlyphName }> = {
  review: { label: 'Ready to accept', glyph: 'review' },
  conflict: { label: 'Conflict', glyph: 'conflict' },
  handoff: { label: 'Handoff to you', glyph: 'handoff' },
  message: { label: 'Message', glyph: 'message' },
  failed: { label: 'Check failed', glyph: 'failed' },
};
const label = (item: DecisionItem) =>
  item.kind === 'message' && item.question ? 'Question' : kinds[item.kind].label;

function MessageText({ text }: { text: string }) {
  const references = useContext(WorkReferenceContext);
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const body = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    if (expanded || !body.current) return;
    const node = body.current;
    const measure = () => setOverflow(node.scrollHeight > node.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text, expanded, references]);
  return (
    <div className="fx-message-text">
      <p ref={body} className={expanded ? '' : 'fx-message-clamp'}>
        <WorkText text={text} />
      </p>
      {(overflow || expanded) && (
        <button
          type="button"
          className="fx-text-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Show less' : 'Expand'}
        </button>
      )}
    </div>
  );
}

/** Ready-to-accept facts: glyph colour is the signal, the words are always there. */
function Gates({ gates }: { gates: NonNullable<DecisionItem['gates']> }) {
  return (
    <div className="fx-gates">
      <span className="fx-gate-ok">
        <Glyph name="passed" size={12} />
        <span>check passed</span>
      </span>
      {gates.main !== undefined && (
        <span className={gates.main ? 'fx-gate-ok' : 'fx-gate-warn'}>
          <Glyph name={gates.main ? 'passed' : 'sync'} size={12} />
          <span>{gates.main ? 'includes main' : 'behind main'}</span>
        </span>
      )}
      <span className={gates.overlaps ? 'fx-gate-warn' : 'fx-gate-ok'}>
        <Glyph name={gates.overlaps ? 'overlap' : 'passed'} size={12} />
        <span>
          {gates.overlaps
            ? `overlaps ${gates.overlaps} ${gates.overlaps === 1 ? 'Lane' : 'Lanes'}`
            : 'no overlaps'}
        </span>
      </span>
    </div>
  );
}

/**
 * Decisions waiting for the viewer. Every item ends with its answers: the recommended one first,
 * a quiet way out last. "Not now" hides an item for this browser session only.
 */
export function NeedsYou({
  items,
  now,
  answers,
  href,
  answered,
  quiet,
  complete = true,
}: {
  items: readonly DecisionItem[];
  now: number;
  answers: (item: DecisionItem, helpers: { notNow: () => void }) => ReactNode;
  href?: (item: DecisionItem) => string | undefined;
  /** "Answered today · 5", when known. */
  answered?: string;
  /** The all-clear's second line, e.g. "4 agents are working." */
  quiet?: string;
  complete?: boolean;
}) {
  const { shown, notNow } = useVisibleDecisions(items);
  const render = (item: DecisionItem) => {
    const link = href?.(item);
    const subtitle =
      item.subtitle && !/^(agent workflow|user_|contributor_)/i.test(item.subtitle.trim())
        ? item.subtitle
        : undefined;
    return (
      <li key={item.id} className={`fx-dec fx-dec-${item.kind}`}>
        <div className="fx-dec-kind">
          <Glyph name={kinds[item.kind].glyph} size={12} />
          {label(item)}
          {item.sender && (
            <span className="fx-dec-sender">
              <Avatar name={item.sender.name} kind={item.sender.agent ? 'agent' : 'human'} size="sm" />
              {item.sender.name}
            </span>
          )}
          {item.audience && <span className="fx-dec-audience">{item.audience}</span>}
          {item.at !== undefined && <span className="fx-dec-age">{age(item.at, now)}</span>}
        </div>
        <div className={`fx-dec-title${item.broadcast ? ' fx-dec-broadcast' : ''}`} title={item.title}>
          {link && !item.broadcast ? <a href={link}>{item.title}</a> : <WorkText text={item.title} />}
          {subtitle && <span className="fx-dec-sub"> · {subtitle}</span>}
        </div>
        {item.gates ? <Gates gates={item.gates} /> : item.body && <MessageText text={item.body} />}
        {item.quote?.text && (
          <blockquote className="fx-quote">
            <MessageText text={item.quote.text} />
          </blockquote>
        )}
        {Boolean(item.earlier?.length) && (
          <details className="fx-earlier">
            <summary>+{item.earlier!.length} earlier</summary>
            {item.earlier!.map(earlier => (
              <div key={earlier.id}>
                <b>{earlier.sender?.name ?? earlier.quote?.from}</b> · {age(earlier.at ?? 0, now)}
                <MessageText text={earlier.quote?.text ?? earlier.body ?? ''} />
              </div>
            ))}
          </details>
        )}
        <div className="fx-answers">
          {answers(item, { notNow: notNow(item.id) })}
          {item.hint && <span className="fx-hint">{item.hint}</span>}
        </div>
      </li>
    );
  };
  return (
    <Panel
      title="Needs you"
      count={shown.length}
      hot
      className="fx-needs-panel"
      labelId="fx-needs-title"
      actions={answered && <span className="fx-faint">{answered}</span>}
    >
      {shown.length === 0 ? (
        <div className="fx-allclear">
          <b>Nothing needs you.</b>
          {quiet && <span className="fx-muted">{quiet}</span>}
        </div>
      ) : shown.length > SCALE_AFTER ? (
        <ScaleGroups
          openFirst
          groups={Object.entries(kinds)
            .map(([kind, value]) => ({
              id: kind,
              title: value.label,
              rows: shown.filter(item => item.kind === kind),
            }))
            .filter(group => group.rows.length)}
          render={render}
          className="fx-decisions"
          noun="item"
        />
      ) : (
        <PagedList rows={shown} render={render} className="fx-decisions" size={5} />
      )}
      {!complete && <p className="fx-panel-note">Showing the most recent items only.</p>}
    </Panel>
  );
}
