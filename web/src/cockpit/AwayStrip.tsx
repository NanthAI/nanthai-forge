// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { Glyph } from '../ui/Glyph';
import { AutoTag, InfoTip } from '../ui/signals';
import type { AwayFact } from './now-model';

/** Absences shorter than this get no summary. */
export const AWAY_AFTER_MS = 2 * 3_600_000;

/**
 * When the viewer was last on Now for this project, read once per page load and then kept current
 * while the page is visible. Stored only in this browser.
 */
export function useLastVisit(key: string, now: number): number | null {
  const storage = `forge.now.seen:${key}`;
  const [previous] = useState<number | null>(() => {
    try {
      const value = Number(localStorage.getItem(storage));
      return Number.isFinite(value) && value > 0 ? value : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    try {
      if (document.visibilityState === 'visible') localStorage.setItem(storage, String(now));
    } catch {
      /* Private mode: no away summary. */
    }
  }, [storage, now]);
  return previous;
}

/** "While you were away (9 h)": at most three facts, then dismiss. It never animates in. */
export function AwayStrip({
  hours,
  facts,
  shippedHref,
  onDismiss,
}: {
  hours: number;
  facts: readonly AwayFact[];
  shippedHref?: string;
  onDismiss: () => void;
}) {
  if (facts.length === 0) return null;
  return (
    <div className="fx-away" role="status">
      <Glyph name="bell" size={14} />
      <b>While you were away ({hours} h)</b>
      <div className="fx-away-facts">
        {facts.map(fact => (
          <span key={fact.id} className={`fx-away-${fact.glyph}`}>
            <Glyph name={fact.glyph} size={12} />
            {fact.text}
            {fact.automatic && <AutoTag />}
            {fact.undo && (
              <InfoTip label="How to undo" inline>
                {fact.undo}
              </InfoTip>
            )}
          </span>
        ))}
        {shippedHref && (
          <a className="fx-away-link" href={shippedHref}>
            What shipped
          </a>
        )}
      </div>
      <button type="button" className="fx-icon-btn fx-away-x" aria-label="Dismiss" onClick={onDismiss}>
        <Glyph name="close" size={13} />
      </button>
    </div>
  );
}
