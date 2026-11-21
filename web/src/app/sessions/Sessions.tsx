// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { api } from '../../../../convex/_generated/api';
import { SESSION_QUIET_MS } from '../../../../src/session-presence';
import { useSafeQuery } from '../../safe-query';
import { navigate, useSearch } from '../router';
import type { PlaceProps } from '../screens';
import type { SessionFilters, SessionsRead } from './model';
import { SessionsView, listHref } from './SessionsView';
import { AgentRun } from './Agent';

export default function Sessions(props: PlaceProps) {
  const [person, run] = props.route.rest.split('/').map(part => decodeURIComponent(part));
  if (person && run) return <AgentRun {...props} person={person} run={run} />;
  return <SessionList {...props} />;
}
function SessionList(props: PlaceProps) {
  const search = useSearch();
  const activity = search.get('activity') === '1';
  const filters = {
    find: search.get('find') ?? '',
    person: search.get('person') ?? '',
    app: search.get('app') ?? '',
    device: search.get('device') ?? '',
    deviceId: search.get('deviceId') ?? '',
  };
  return (
    <SessionPage
      key={JSON.stringify([props.projectId, activity, filters])}
      {...props}
      activity={activity}
      filters={filters}
    />
  );
}
function SessionPage(props: PlaceProps & { activity: boolean; filters: SessionFilters }) {
  const { projectId, activity, filters, route } = props;
  const [cursor, setCursor] = useState<string | null>(null);
  const [observedAt, setObservedAt] = useState(Date.now);
  const [now, setNow] = useState(observedAt);
  const result = useSafeQuery(api.projectSessions.read, { projectId, cursor, filters, activity, observedAt });
  const data = result.value ? (JSON.parse(result.value) as SessionsRead) : undefined;
  const expiry = activity
    ? undefined
    : data?.rows.reduce<number | undefined>((next, row) => {
        const at = row.lastSeen + SESSION_QUIET_MS;
        return at > now && (next === undefined || at < next) ? at : next;
      }, undefined);
  useEffect(() => {
    if (expiry === undefined) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, expiry - Date.now()));
    return () => clearTimeout(timer);
  }, [expiry, now]);

  return (
    <SessionsView
      {...props}
      data={data}
      now={now}
      readFailed={!!result.error}
      setFilters={next => navigate(listHref(route, next, activity))}
      more={() => {
        if (!data) return;
        setNow(Date.now());
        setCursor(data.continueCursor);
      }}
      first={() => {
        const at = Date.now();
        setObservedAt(at);
        setNow(at);
        setCursor(null);
      }}
    />
  );
}
