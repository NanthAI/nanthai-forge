// SPDX-License-Identifier: Apache-2.0
// The Lanes place (Items e317b6ea, c613e6bc History, eb0bbb94): its own chunk, loaded with the route. Sessions, one
// Lane, its holder, its check and its landing evidence each register their own screen (sessions/, lane/, check/,
// proof/ route.ts), so this place only serves the overview, History and Touching. An address under Lanes that no
// screen serves says so and links back to the overview, never to an older screen (tests/app-screen-routes).
import { useEffect } from 'react';
import { A } from '../frames';
import { hrefFor } from '../paths';
import { Head, crumbsFor } from '../Place';
import { navigate } from '../router';
import type { LanesProps } from './common';
import { History } from './History';
import { Overview } from './Overview';
import { Touching } from './Touching';
import './lanes.css';

export default function LanesPlace(props: LanesProps) {
  const { route } = props;
  const href = hrefFor(route);
  // An old To read link opened History: show History's own address, keeping the query.
  useEffect(() => {
    if (route.section === 'history' && location.pathname !== href)
      navigate(`${href}${location.search}${location.hash}`, { replace: true });
  }, [route.section, href]);
  if (route.rest)
    return (
      <Head trail={crumbsFor(route, props.projectName)} sentence="Forge has no Lanes screen at this address.">
        <A className="btn sm" href={hrefFor({ ...route, section: '', rest: '' })}>
          Open Lanes
        </A>
      </Head>
    );
  if (route.section === 'history') return <History {...props} />;
  if (route.section === 'touching') return <Touching {...props} />;
  return <Overview {...props} />;
}
