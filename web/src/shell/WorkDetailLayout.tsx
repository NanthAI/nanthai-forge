// SPDX-License-Identifier: Apache-2.0
import { createContext, useContext, type ReactNode } from 'react';
import { Glyph } from '../ui/Glyph';
import { useLanePreference } from '../lane/preferences';
import './work-detail.css';

const CollapseSide = createContext<(() => void) | undefined>(undefined);

/** Put in the first side panel's header; collapses the side column to a rail (remembered). */
export function CollapseSideButton() {
  const collapse = useContext(CollapseSide);
  return collapse ? (
    <button
      className="fx-collapse"
      type="button"
      onClick={collapse}
      aria-label="Collapse side panels"
      title="Collapse side panels (remembered)"
    >
      <Glyph name="arrow" size={12} />
    </button>
  ) : null;
}

/**
 * One detail layout for Lane, Intent and Initiative pages:
 * crumbs · header · next step · main | side (Timeline, Conversation). No tabs.
 */
export function WorkDetailLayout({
  className,
  crumbs,
  header,
  next,
  children,
  side,
  timelineCount,
  messageCount,
}: {
  className?: string;
  crumbs?: ReactNode;
  header: ReactNode;
  next?: ReactNode;
  children: ReactNode;
  side: ReactNode;
  timelineCount: number;
  messageCount: number;
}) {
  const [state, setState] = useLanePreference('forge.lane.side', ['open', 'closed'], 'open');
  return (
    <div className={className ? `fx-page fx-detail ${className}` : 'fx-page fx-detail'}>
      {crumbs}
      {header}
      {next}
      <div className="fx-lane-grid fx-detail-grid" data-side={state}>
        <div className="fx-lane-col">{children}</div>
        <aside className="fx-lane-col fx-detail-side">
          <button
            type="button"
            className="fx-rail-btn"
            aria-label="Show Timeline and Conversation"
            onClick={() => setState('open')}
          >
            <Glyph name="back" size={12} />
            <span>Timeline</span>
            <b className="fx-count">{timelineCount}</b>
            <span>Conversation</span>
            <b className="fx-count">{messageCount}</b>
          </button>
          <CollapseSide.Provider value={() => setState('closed')}>{side}</CollapseSide.Provider>
        </aside>
      </div>
    </div>
  );
}
