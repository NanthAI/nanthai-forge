// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useState } from 'react';
import { cleanUrl, routeUrlState } from '../shell/location';
import { readIntentFilter, type IntentFilter } from './model';
export type IntentLayout = 'list' | 'board';
export const layoutKey = (scope: string) => `forge.intents.layout:${scope}`;
export function readIntentLayout(search: string, saved: string | null): IntentLayout {
  const requested = new URLSearchParams(search).get('intentLayout');
  return (requested ?? saved) === 'board' ? 'board' : 'list';
}
const readFilter = (): IntentFilter => readIntentFilter(routeUrlState().searchParams.get('intentFilter'));
/** URL wins over this browser's per-account/project preference. Storage may be disabled. */
export function useIntentLayout(scope: string) {
  const read = useCallback(() => {
    let saved = null;
    try {
      saved = localStorage.getItem(layoutKey(scope));
    } catch {
      /* URL still works. */
    }
    return { layout: readIntentLayout(routeUrlState().search, saved), filter: readFilter() };
  }, [scope]);
  const [state, setState] = useState(read);
  useEffect(() => {
    const refresh = () => setState(read());
    refresh();
    addEventListener('popstate', refresh);
    addEventListener('storage', refresh);
    return () => {
      removeEventListener('popstate', refresh);
      removeEventListener('storage', refresh);
    };
  }, [read]);
  useEffect(() => {
    try {
      localStorage.setItem(layoutKey(scope), state.layout);
    } catch {
      /* URL still works. */
    }
    const url = routeUrlState();
    if (url.searchParams.get('intentLayout') !== state.layout) {
      url.searchParams.set('intentLayout', state.layout);
      history.replaceState(history.state, '', cleanUrl(url.href));
    }
  }, [state.layout, scope]);
  const update = (layout: IntentLayout, filter: IntentFilter) => {
    const url = routeUrlState();
    url.searchParams.set('intentLayout', layout);
    url.searchParams.set('intentFilter', filter);
    history.replaceState(history.state, '', cleanUrl(url.href));
    try {
      localStorage.setItem(layoutKey(scope), layout);
    } catch {
      /* Preference is optional. */
    }
    setState({ layout, filter });
  };
  return {
    ...state,
    showDone: () => update('list', 'done'),
    setLayout: (layout: IntentLayout) => update(layout, state.filter),
    setFilter: (filter: IntentFilter) => update(state.layout, filter),
  };
}
