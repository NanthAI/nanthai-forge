import { queueHref } from '../cockpit/queue-model';
// SPDX-License-Identifier: Apache-2.0
import { Fragment, type MouseEvent, type ReactNode } from 'react';
import { Glyph, type GlyphName } from './Glyph';
import type { LaneFact } from './lane-facts';
import { Avatar, StatusPill } from './primitives';
import type { Tone } from './status';
import './work-row.css';

/** The one Work row (Intents, Lanes, Planning): tone rail · title and fact line · pill · age. */
export function WorkRow({
  tone,
  title,
  href,
  onOpen,
  fact,
  label,
  pillGlyph,
  age,
  done = false,
}: {
  tone: Tone;
  title: string;
  href: string;
  /** In-page navigation for plain clicks; modified clicks keep the link's default. */
  onOpen?: () => void;
  fact?: ReactNode;
  label: string;
  pillGlyph?: GlyphName;
  age?: ReactNode;
  done?: boolean;
}) {
  const open = onOpen
    ? (event: MouseEvent<HTMLAnchorElement>) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onOpen();
      }
    : undefined;
  return (
    <li className={`fx-wr fx-wr-${tone}${done ? ' fx-wr-done' : ''}`}>
      <div className="fx-wr-main">
        <a href={href} className="fx-wr-title" title={title} onClick={open}>
          {title}
        </a>
        {fact && <div className="fx-wr-fact">{fact}</div>}
      </div>
      <StatusPill tone={tone} {...(pillGlyph ? { glyph: pillGlyph } : {})}>
        {label}
      </StatusPill>
      <span className="fx-wr-age">{age}</span>
    </li>
  );
}

/** Lane fact line: Intent (when it differs) · holder · what happened and when. */
export function LaneFactLine({ fact, showIntent = true }: { fact: LaneFact; showIntent?: boolean }) {
  const parts: ReactNode[] = [];
  if (showIntent && fact.intent)
    parts.push(
      <span className="fx-wr-intent" title={`Intent: ${fact.intent}`}>
        <Glyph name="intent" size={12} />
        {fact.intent}
      </span>,
    );
  if (fact.who)
    parts.push(
      <span className="fx-wr-who">
        <Avatar name={fact.who.name} identity={fact.who.identity} kind={fact.who.kind} size="sm" />
        {fact.who.name}
      </span>,
    );
  parts.push(
    <span className="fx-wr-what">
      {fact.glyph && <Glyph name={fact.glyph} size={12} className={`fx-wr-g-${fact.tone}`} />}
      <span title={fact.detail}>{fact.text}</span>
      {fact.queue?.link && (
        <>
          {' '}
          · <a href={queueHref(fact.queue.link)}>{fact.queue.link.label}</a>
        </>
      )}
      {fact.auto && (
        <>
          <span className="fx-wr-auto">auto</span>{' '}
          <span className="fx-undo-none" title={fact.queue?.undo}>
            Undo
          </span>
        </>
      )}
    </span>,
  );
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 && (
            <span className="fx-wr-sep" aria-hidden="true">
              ·
            </span>
          )}
          {part}
        </Fragment>
      ))}
    </>
  );
}
