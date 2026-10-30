// SPDX-License-Identifier: Apache-2.0
import { PagedList } from './ScaleList';
import { useState } from 'react';
import { Glyph } from '../ui/Glyph';
import { Avatar, Panel } from '../ui/primitives';
import { InfoTip } from '../ui/signals';
import type { OverlapRow } from './overlap-model';

type Tell = NonNullable<NonNullable<OverlapRow['action']>['tell']>;

/** Where work meets: the file, who is in it, and what will happen, ending in one action. */
export function Overlaps({
  rows,
  laneHref,
  tell,
}: {
  rows: readonly OverlapRow[];
  laneHref: (laneId: string) => string;
  /** Sends a short "please wait" message to a session; hosted only. */
  tell?: (target: Tell, path: string) => Promise<boolean>;
}) {
  const [told, setTold] = useState<Record<string, 'sending' | 'sent' | 'failed'>>({});
  const render = (row: OverlapRow) => {
    const action = row.action;
    const state = told[row.path];
    return (
      <li key={row.path} className={`fx-ov fx-ov-${row.kind}`}>
        <div className="fx-ov-file">
          <code title={row.path}>{row.path}</code>
          <small>
            {row.detail}
            {Boolean(row.unanswered?.length) && (
              <>
                {' '}
                ·{' '}
                <span className="fx-ov-unanswered">
                  unanswered by {row.unanswered!.slice(0, 2).join(', ')}
                  {row.unanswered!.length > 2 ? ` +${row.unanswered!.length - 2}` : ''}
                </span>
              </>
            )}{' '}
            <InfoTip label={`About overlap in ${row.path}`} inline>
              {row.meaning}
            </InfoTip>
          </small>
        </div>
        <div className="fx-ov-who">
          {row.who.map(who => {
            const chip = (
              <>
                {who.main ? (
                  <Glyph name="channel" size={12} />
                ) : (
                  <Avatar name={who.label} size="sm" kind={who.agent ? 'agent' : 'human'} />
                )}
                <span>{who.label}</span>
              </>
            );
            return who.laneId ? (
              <a key={who.label} className="fx-chip" href={laneHref(who.laneId)}>
                {chip}
              </a>
            ) : (
              <span key={who.label} className="fx-chip">
                {chip}
              </span>
            );
          })}
        </div>
        <div className="fx-ov-meaning">
          <span>{row.meaning}</span>{' '}
          {action?.laneId && (
            <a className="fx-ov-act" href={laneHref(action.laneId)}>
              {action.label}
            </a>
          )}
          {action?.tell &&
            tell &&
            (state === 'sent' ? (
              <span className="fx-faint">Told {action.tell.name}.</span>
            ) : (
              <button
                type="button"
                className="fx-ov-act"
                disabled={state === 'sending'}
                onClick={() => {
                  setTold(previous => ({ ...previous, [row.path]: 'sending' }));
                  void tell(action.tell!, row.path).then(ok =>
                    setTold(previous => ({ ...previous, [row.path]: ok ? 'sent' : 'failed' })),
                  );
                }}
              >
                {state === 'failed' ? `Retry: ${action.label}` : action.label}
              </button>
            ))}
        </div>
      </li>
    );
  };
  if (rows.length === 0) return null;
  return (
    <Panel
      title="Where work overlaps"
      count={rows.length}
      labelId="fx-overlaps"
      actions={
        <InfoTip label="About overlaps">
          Overlaps are advisory: Forge never locks files. Whichever Lane is accepted second updates from main
          first.
        </InfoTip>
      }
    >
      <PagedList rows={rows} render={render} className="fx-ovs" size={5} />
    </Panel>
  );
}
