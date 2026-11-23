// SPDX-License-Identifier: Apache-2.0
// Held, redone or refused (Needs me): everything Forge held, redid or refused, newest first, with the Lanes held now
// at the top of it, whether they wait on the reader (those are decided on Needs me) or on their agent. It reads what
// Needs me reads (projectNeedsMe:read, projectNeedsFyi:read), so the two pages, the top bar and the count say one
// thing; re-run on server writes only, idle costs nothing (Item 9b9057a9).
import { useMemo } from 'react';
import { useMutation, useQuery } from 'convex/react';
import './needs.css';
import { Announcer, useAnnounce } from '../../ds/behaviour/announce';
import { usePageCritical } from '../../ui/page-critical';
import { hrefFor } from '../paths';
import { Head, crumbsFor } from '../Place';
import type { PlaceProps } from '../screens';
import { needsRead } from './count';
import { Fyi } from './FyiRegion';
import { fyiDismiss, fyiRead } from './fyi-reads';
import { fyiView, type FyiRead } from './fyi';
import { heldSentence, needsView } from './model';

export default function HeldPage({ route, projectId, projectName }: PlaceProps) {
  const read = useQuery(needsRead, { projectId });
  const fyiLive = useQuery(fyiRead, { projectId });
  const fyi = useMemo(
    () => (fyiLive === undefined ? undefined : (JSON.parse(fyiLive) as FyiRead)),
    [fyiLive],
  );
  const dismissMutation = useMutation(fyiDismiss);
  const [message, announce] = useAnnounce();
  usePageCritical('Held', { needs: read !== undefined, fyi: fyiLive !== undefined });
  const drawnAt = useMemo(() => Date.now(), [read, fyi]);
  const view = useMemo(() => (read ? needsView(read, drawnAt) : null), [read, drawnAt]);
  const list = useMemo(
    () => (fyi && view ? fyiView(fyi, [...view.now, ...view.fyi], drawnAt) : null),
    [fyi, view, drawnAt],
  );
  const sentence = view ? heldSentence(view) : null;
  return (
    <div className="needs-me">
      <Head
        trail={crumbsFor(route, projectName)}
        sentence={
          sentence ? (
            <>
              <b>{sentence.bold}</b> {sentence.rest}
            </>
          ) : (
            'Loading what was held…'
          )
        }
      />
      <Fyi
        all
        handle={null}
        view={list}
        state={fyi?.state}
        drawnAt={drawnAt}
        dismiss={input => dismissMutation({ projectId, ...input })}
        announce={announce}
        href={link =>
          hrefFor({
            ...route,
            place: link.place as typeof route.place,
            section: link.section ?? '',
            rest: link.rest ?? '',
          })
        }
      />
      <Announcer message={message} />
    </div>
  );
}
