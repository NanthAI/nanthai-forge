// SPDX-License-Identifier: Apache-2.0
// The Lanes place (Items e317b6ea, c613e6bc History, eb0bbb94): its own chunk, loaded with the route. Sessions and a
// single Lane's page are not rebuilt here; they keep the placeholder that links to the screen serving them today.
import { useEffect } from 'react';
import { hrefFor } from '../paths';
import { navigate } from '../router';
import { Placeholder } from '../Place';
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
  if (route.rest || route.section === 'sessions')
    return <Placeholder route={route} projectName={props.projectName} />;
  if (route.section === 'history') return <History {...props} />;
  if (route.section === 'touching') return <Touching {...props} />;
  return <Overview {...props} />;
}
