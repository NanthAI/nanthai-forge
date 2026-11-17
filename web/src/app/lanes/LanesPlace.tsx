// SPDX-License-Identifier: Apache-2.0
// The Lanes place (Items e317b6ea, 9e748e41 To read, eb0bbb94): its own chunk, loaded with the route. Sessions and a
// single Lane's page are not rebuilt here; they keep the placeholder that links to the screen serving them today.
import { Placeholder } from '../Place';
import type { LanesProps } from './common';
import { Overview } from './Overview';
import { ToRead } from './ToRead';
import { Touching } from './Touching';
import './lanes.css';

export default function LanesPlace(props: LanesProps) {
  const { route } = props;
  if (route.rest || route.section === 'sessions')
    return <Placeholder route={route} projectName={props.projectName} />;
  if (route.section === 'to-read') return <ToRead {...props} />;
  if (route.section === 'touching') return <Touching {...props} />;
  return <Overview {...props} />;
}
