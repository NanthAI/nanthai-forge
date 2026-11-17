// SPDX-License-Identifier: Apache-2.0
// Needs me › Loose ends, folded (Items 48049998, fc1831eb): what was started and left, read from projectLooseEnds:read
// only while the region is open (a folded region costs nothing). A Lane nobody holds can be set aside here, one at a
// time, through the existing dormant sweep (which re-checks it: one that gained a save meanwhile is skipped). "Ask an
// agent to tidy up" copies one instruction an agent can follow with the existing loose-ends read. The Loose ends
// section stays as the expanded view, with picking many at once.
import { useMemo, useState } from 'react';
import { useQuery } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import type { Id } from '../../../../convex/_generated/dataModel';
import { Band, Key, Row, State, Who } from '../../ds';
import { Announcer, useAnnounce } from '../../ds/behaviour/announce';
import { A } from '../frames';
import { looseEndsView, setAsideWord, type LooseEndsRead } from './loose-ends';

const looseRead = makeFunctionReference<'query', { projectId: Id<'hostedProjects'> }, string>(
  'projectLooseEnds:read',
);
export type SetAside = (authorityEpoch: number, laneIds: string[]) => Promise<string>;

/** What an agent is asked to do: the existing read, each row's own `next`, and nothing past it. */
export const TIDY_TEXT =
  'Tidy up this Forge project\'s loose ends: run nforge agent . lanes \'{"view":"loose-ends"}\' and, for each row that has a next command, run it. Leave rows without one alone and list them for me.';

export function LooseFold({
  projectId,
  open,
  setAside,
  allHref,
}: {
  projectId: Id<'hostedProjects'>;
  open: boolean;
  setAside: SetAside;
  allHref: string;
}) {
  const live = useQuery(looseRead, open ? { projectId } : 'skip');
  const read = useMemo(() => (live === undefined ? undefined : (JSON.parse(live) as LooseEndsRead)), [live]);
  if (!open) return null;
  return <LooseFoldView read={read} setAside={setAside} allHref={allHref} />;
}

export function LooseFoldView({
  read,
  setAside,
  allHref,
  copy = text => navigator.clipboard.writeText(text),
}: {
  read: LooseEndsRead | undefined;
  setAside: SetAside;
  allHref: string;
  copy?: (text: string) => Promise<void>;
}) {
  const [outcome, setOutcome] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, announce] = useAnnounce();
  if (!read)
    return (
      <div className="quietline" aria-busy="true">
        Loading loose ends…
      </div>
    );
  const view = looseEndsView(read, read.at);
  const shown = view.groups.filter(group => !group.reported || group.rows.length);
  const one = async (laneId: string) => {
    if (!read.setAside) return;
    setBusy(laneId);
    let result = 'failed';
    try {
      const reply = JSON.parse(await setAside(read.setAside.authorityEpoch, [laneId])) as {
        results?: { laneId: string; result: string }[];
      };
      result = reply.results?.find(entry => entry.laneId === laneId)?.result ?? 'failed';
    } catch {
      // Reported as "Could not set aside"; pressing again retries only this Lane.
    }
    setOutcome(old => ({ ...old, [laneId]: result }));
    setBusy(null);
    announce(setAsideWord(result).word);
  };
  return (
    <>
      {shown.length ? (
        shown.map(group => (
          <div className="grp" key={group.key}>
            <Band
              title={group.title}
              count={group.reported ? group.rows.length : undefined}
              hint={group.reported ? group.hint : `not reported: ${group.why}`}
            />
            {group.rows.slice(0, 3).map(row => {
              const result = outcome[row.laneId];
              const word = result ? setAsideWord(result) : null;
              return (
                <Row key={row.laneId} cols="minmax(0, 1fr) auto" className="loose-row">
                  <span className="ttl" dir="auto">
                    {row.title || 'Lane without a goal'}
                    <span className="meta">
                      {' '}
                      {row.who ? <Who handle={row.who} /> : null} {row.age}
                      {row.replacedBy ? `, replaced by Lane ${row.replacedBy.slice(0, 8)}` : ''}
                    </span>
                  </span>
                  <span className="r">
                    {word ? (
                      <State word={word.done ? 'Done' : word.retry ? 'Check failed' : 'Set aside'}>
                        {word.word}
                      </State>
                    ) : group.key === 'idle' && read.setAside ? (
                      <Key size="sm" disabled={busy !== null} onClick={() => void one(row.laneId)}>
                        Set aside
                      </Key>
                    ) : null}
                  </span>
                </Row>
              );
            })}
            {group.rows.length > 3 || group.more ? (
              <div className="pf">
                {Math.min(3, group.rows.length)} of {group.rows.length}
                {group.more ? ' or more' : ''}; the rest are in <A href={allHref}>Loose ends</A>.
              </div>
            ) : null}
          </div>
        ))
      ) : (
        <div className="quietline">Nothing is loose.</div>
      )}
      <div className="pf needs-fold">
        <A href={allHref} className="lk">
          All loose ends, with picking many
        </A>
        <Key
          size="sm"
          kind="ghost"
          title={TIDY_TEXT}
          onClick={() =>
            copy(TIDY_TEXT).then(
              () => announce('Copied. Paste it to an agent working in this project.'),
              () => announce(`Could not copy. The text is: ${TIDY_TEXT}`),
            )
          }
        >
          Ask an agent to tidy up
        </Key>
      </div>
      <Announcer message={message} />
    </>
  );
}
