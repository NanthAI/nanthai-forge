// SPDX-License-Identifier: Apache-2.0
import { intentProgress } from '../../src/work-intent-progress';
import { PagedList } from './cockpit/ScaleList';
import { StatusPill } from './ui/primitives';
import { useEffect, useRef, useState, type ComponentProps } from 'react';
import type { AttributedPlanningItem } from './planning/attribution';
import type { PlanningItem, PlanningWrite } from '../../src/work-planning-types';
import type { PlanningAct } from './WorkPlanning';
import { IntentDetailView } from './intents/IntentDetail';
import { IntentEditForm } from './intents/IntentParts';
import { StatusMenu, type IntentAction } from './intents/StatusMenu';
import { Breadcrumbs, workHref } from './shell/Breadcrumbs';
import { planningDestination } from './shell/route';
import { age } from './ui/status';
import { Glyph } from './ui/Glyph';
import { ErrorToast } from './ui/Toast';
import type { LifecycleParts } from './lane/OwnerLifecycle';
import './planning.css';

export function PlanningIntents({
  ids,
  intents,
  lanes,
  href,
}: {
  ids: readonly string[];
  intents: readonly { id: string; outcome: string; status: string }[];
  lanes: readonly { intentId: string }[];
  href: (id: string) => string;
}) {
  const rows = ids.flatMap(id => {
    const intent = intents.find(value => value.id === id);
    if (!intent) return [];
    const label = intentProgress(intent.status, lanes.filter(lane => lane.intentId === id).length);
    return [{ ...intent, label }];
  });
  return (
    <PagedList
      rows={rows}
      size={5}
      label="linked Intents"
      className="planning-linked-intents"
      render={intent => (
        <li key={intent.id}>
          <a href={href(intent.id)}>{intent.outcome}</a>
          <StatusPill
            tone={
              intent.label === 'Planned' || intent.label === 'Abandoned'
                ? 'plain'
                : intent.label === 'Working'
                  ? 'active'
                  : 'passed'
            }
          >
            {intent.label}
          </StatusPill>
        </li>
      )}
    />
  );
}

/** One detail page for planning-only and execution-backed Intents. */
export function PlanningIntentPage({
  item,
  initiatives,
  detail,
  readOnly,
  busy,
  act,
  loadItem,
  lifecycle,
  origin,
}: {
  item: AttributedPlanningItem;
  origin?: AttributedPlanningItem;
  initiatives: readonly PlanningItem[];
  detail: ComponentProps<typeof IntentDetailView>;
  readOnly?: boolean;
  busy?: boolean;
  act?: PlanningAct;
  loadItem?: () => Promise<PlanningItem>;
  lifecycle?: LifecycleParts | null;
}) {
  const [saved, setSaved] = useState<PlanningItem>();
  const [hydrated, setHydrated] = useState<PlanningItem>();
  const loader = useRef(loadItem);
  loader.current = loadItem;
  useEffect(() => {
    let active = true;
    if (loader.current)
      void loader
        .current()
        .then(full => {
          if (active) setHydrated(full);
        })
        .catch(error => {
          if (active) setError((error as Error).message);
        });
    return () => {
      active = false;
    };
  }, [item.id, item.version]);
  const source = hydrated?.id === item.id && hydrated.version === item.version ? hydrated : item;
  const current = saved && saved.version >= source.version ? saved : source;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<PlanningItem>();
  const [title, setTitle] = useState(current.title);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const pending = useRef<Extract<PlanningWrite, { action: 'put-planning-item' }> | undefined>(undefined);
  const pendingInput = useRef('');
  const pendingFull = useRef<PlanningItem | undefined>(undefined);
  const started = detail.row.lanes.length > 0;
  const closed =
    !started && saved && saved.version >= item.version
      ? current.status === 'closed'
      : detail.row.status === 'abandoned' || detail.row.status === 'completed';
  const groups = initiatives.filter(group => group.kind === 'initiative');
  const linked = groups.filter(
    group => group.id === current.initiativeId || detail.planning.some(link => link.id === group.id),
  );
  const fullItem = async () =>
    saved && saved.version > item.version ? saved : loadItem ? loadItem() : current;
  async function write(changes: Partial<Pick<PlanningItem, 'title' | 'body' | 'initiativeId' | 'status'>>) {
    if (!act) return 'Editing is not available for this Intent.';
    setWorking(true);
    try {
      const input = JSON.stringify(changes);
      const full =
        pending.current && pendingInput.current === input && pendingFull.current
          ? pendingFull.current
          : changes.title !== undefined && draft
            ? draft
            : await fullItem();
      const next = { ...full, ...changes };
      const payload = {
        action: 'put-planning-item' as const,
        itemId: full.id,
        expectedVersion: full.version,
        kind: full.kind,
        title: next.title,
        body: next.body,
        status: next.status,
        intentIds: full.intentIds,
        ...(next.initiativeId ? { initiativeId: next.initiativeId } : {}),
      };
      // Retain the operation across an unknown result; a changed draft is a different request.
      const previous = pending.current;
      const operationId =
        previous && JSON.stringify({ ...previous, operationId: undefined }) === JSON.stringify(payload)
          ? previous.operationId
          : crypto.randomUUID();
      const command = { ...payload, operationId };
      pending.current = command;
      pendingInput.current = input;
      pendingFull.current = full;
      const acknowledgement = await act(command);
      if (acknowledgement?.operationId !== operationId)
        return 'The request did not complete. Retry keeps its original operation.';
      pending.current = undefined;
      setSaved({
        ...next,
        version: full.version + 1,
        previousVersion: full.version,
        operationId,
        at: new Date().toISOString(),
      });
      setEditing(false);
      setError('');
      return null;
    } catch (error) {
      return (error as Error).message;
    } finally {
      setWorking(false);
    }
  }
  async function edit() {
    setWorking(true);
    try {
      const full = await fullItem();
      setDraft(full);
      setTitle(full.title);
      setEditing(true);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setWorking(false);
    }
  }
  async function status(action: IntentAction) {
    if (lifecycle && action !== 'plan') {
      if (action === 'abandon') lifecycle.abandon?.();
      else if (action === 'complete') lifecycle.complete?.();
      else lifecycle.reopen?.();
      return;
    }
    if (started && detail.setStatus) {
      const problem = await detail.setStatus(
        action === 'complete' ? 'completed' : action === 'abandon' ? 'abandoned' : 'active',
      );
      setError(problem ?? '');
      return;
    }
    const problem = await write({ status: action === 'complete' ? 'closed' : 'open' });
    setError(problem ?? '');
  }
  const row = {
    ...detail.row,
    outcome: editing ? title : current.title,
    constraints: current.body,
    ...(!started && saved
      ? {
          status: closed ? ('completed' as const) : ('active' as const),
          label: closed ? 'Done' : 'Planned',
          tone: closed ? ('passed' as const) : ('plain' as const),
        }
      : {}),
  };
  const creator =
    origin?.actorDisplayName ?? row.createdBy ?? (item.version === 1 ? item.actorDisplayName : undefined);
  const timeline = [...(detail.timeline ?? [])];
  if (saved && !timeline.some(event => event.id === `planning:${saved.operationId}`))
    timeline.unshift({
      id: `planning:${saved.operationId}`,
      at: saved.at,
      text:
        saved.status !== item.status ? (saved.status === 'closed' ? 'Done' : 'Planned') : 'Details edited',
      detail: `version ${saved.version}`,
      glyph: 'file',
      tone: 'plain',
    });
  return (
    <>
      <IntentDetailView
        {...detail}
        row={row}
        timeline={timeline}
        back={
          <Breadcrumbs
            items={[
              ...linked.map(group => ({
                label: group.title,
                href: workHref(planningDestination({ kind: 'initiative', id: group.id })),
              })),
              {
                label: current.title,
                href: workHref(
                  planningDestination({
                    kind: detail.canStart === false ? 'planning' : 'intent',
                    id: detail.canStart === false ? current.id : (detail.startIntentId ?? row.id),
                  }),
                ),
              },
            ]}
          />
        }
        meta={
          <>
            {linked.map(group => (
              <a key={group.id} href={workHref(planningDestination({ kind: 'initiative', id: group.id }))}>
                <Glyph name="initiative" size={12} />
                {group.title}
              </a>
            ))}
            <span>
              {started
                ? `${row.lanes.length} ${row.lanes.length === 1 ? 'Lane' : 'Lanes'} · ${detail.views.length} ${detail.views.length === 1 ? 'Candidate' : 'Candidates'}`
                : 'no Lane yet'}
            </span>
            <span>
              {started ? 'started' : 'planned'}{' '}
              {row.createdAt ? age(row.createdAt, detail.now, true) : age(current.at, detail.now, true)}
              {creator && <> by {creator}</>}
              {current.version > 1 && <> · edited {age(current.at, detail.now, true)}</>}
            </span>
          </>
        }
        onEdit={!readOnly && act ? () => void edit() : undefined}
        editHref={undefined}
        editor={
          editing && draft ? (
            <IntentEditForm
              title={title}
              body={draft.body}
              initiativeId={draft.initiativeId}
              initiatives={groups}
              busy={busy || working}
              onTitle={setTitle}
              cancel={() => setEditing(false)}
              save={draft => write(draft)}
            />
          ) : undefined
        }
        statusControl={
          !readOnly && (act || lifecycle || detail.setStatus) ? (
            <StatusMenu
              label={row.label}
              tone={row.tone}
              closed={closed}
              planned={!started}
              busy={busy || working || Boolean(lifecycle && !lifecycle.complete && !lifecycle.reopen)}
              abandon={Boolean(lifecycle?.abandon || (started && detail.setStatus))}
              onAction={action => void status(action)}
            />
          ) : undefined
        }
        more={
          <>
            {detail.more}
            {lifecycle?.status}
          </>
        }
      />
      {lifecycle?.dialog}
      <ErrorToast error={error} />
    </>
  );
}
