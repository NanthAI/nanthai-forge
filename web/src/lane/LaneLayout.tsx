// SPDX-License-Identifier: Apache-2.0
import { createContext, useContext, type ReactNode } from 'react';
import { Glyph } from '../ui/Glyph';
import { useLanePreference } from './preferences';
const CollapseSide = createContext<(() => void) | undefined>(undefined);
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
export function LaneLayout({
  children,
  side,
  timelineCount,
  messageCount,
}: {
  children: ReactNode;
  side: ReactNode;
  timelineCount: number;
  messageCount: number;
}) {
  const [state, setState] = useLanePreference('forge.lane.side', ['open', 'closed'], 'open');
  return (
    <div className="fx-lane-grid" data-side={state}>
      <div className="fx-lane-col">{children}</div>
      <aside className="fx-lane-col fx-lane-side">
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
  );
}
