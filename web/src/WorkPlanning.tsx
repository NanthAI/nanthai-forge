// SPDX-License-Identifier: Apache-2.0
import { LifecycleDialog } from './lane/LifecycleDialog';
import { useEffect, useRef, useState, type ReactNode, type FormEvent } from 'react';
import { planningActor, type AttributedPlanningItem } from './planning/attribution';
import { InitiativePage, InitiativeConversation, PlanningRowFact } from './planning/InitiativePage';
import { Menu } from './ui/Menu';
import { ErrorToast } from './ui/Toast';
import { Button, Panel, Segmented, StatusPill } from './ui/primitives';
import { WorkRow } from './ui/WorkRow';
import { age } from './ui/status';
import { Glyph } from './ui/Glyph';
import {
  planningGroups,
  initiativeProgress,
  initiativeRows,
  planningRowMatches,
  type PlanningFilter,
  type PlanningLane,
  type PlanningRow,
} from './planning-rows';
import { intentFilterLabels, intentFilters } from './intents/model';
import { PagedList } from './cockpit/ScaleList';
import { CopyPrompt } from './cockpit/CopyPrompt';
import { cleanUrl, routeUrlState } from './shell/location';
import { planningDestination } from './shell/route';
import { PageHead } from './shell/Shell';
import { useWorkHeader } from './shell/WorkHeader';
import { ActionPanel, useDestination } from './WorkspaceUI';
import type { PlanningCommand, PlanningItem, PlanningWrite, WorkData } from '../../src/work-types';

export type PlanningData = Pick<
  WorkData,
  'revision' | 'intents' | 'planningItems' | 'planningComments' | 'hostedEvents'
> & { lanes?: readonly PlanningLane[] };
export type PlanningExport = { json: string; filename: string; sha256: string };
export type PlanningAct = (command: PlanningWrite) => Promise<{ operationId: string } | void>;
type Props = {
  data: PlanningData;
  readOnly?: boolean;
  busy: boolean;
  act: PlanningAct;
  provenance?: (operationId: string) => ReactNode;
  commentContent?: (comment: WorkData['planningComments'][number]) => ReactNode;
};
function PlanningProvenance({ operationId, data }: { operationId: string; data: PlanningData }) {
  const event = (data.hostedEvents ?? []).find(
    event =>
      event.id === operationId &&
      (event.command.action === 'put-planning-item' || event.command.action === 'comment-planning-item'),
  );
  return (
    <ActionPanel title="Entry provenance" className="item-provenance">
      <p>User-declared planning record. Discussion names are supplied labels.</p>
      {event && (
        <p>
          Server-recorded actor <code>{event.actor}</code> · operation <code>{event.id}</code> · {event.at}.
          An exported observation does not authenticate offline authorship.
        </p>
      )}
    </ActionPanel>
  );
}
export function PlanningThread({
  itemId,
  readOnly = false,
  data,
  busy,
  act,
  provenance,
  commentContent,
}: Props & { itemId: string }) {
  const [text, setText] = useState(''),
    [author, setAuthor] = useState('');
  const [pending, setPending] = useState<Extract<
    PlanningCommand,
    { action: 'comment-planning-item' }
  > | null>(null);
  const confirmed = data.planningComments.some(item => item.id === pending?.operationId);
  useEffect(() => {
    if (confirmed) {
      setPending(null);
      setText('');
    }
  }, [confirmed]);
  return (
    <div>
      {data.planningComments
        .filter(item => item.itemId === itemId)
        .map(item => (
          <div className="work-note" key={item.id}>
            {commentContent ? (
              commentContent(item)
            ) : (
              <>
                <small>
                  {item.authorLabel || '—'} · <time title={item.at}>{age(item.at, Date.now())}</time>
                </small>
                <p>{item.text}</p>
              </>
            )}
            {provenance ? provenance(item.id) : <PlanningProvenance operationId={item.id} data={data} />}
          </div>
        ))}
      {!readOnly && (
        <form
          onSubmit={event => {
            event.preventDefault();
            const command = pending ?? {
              action: 'comment-planning-item' as const,
              operationId: crypto.randomUUID(),
              itemId,
              text,
              authorLabel: author,
            };
            setPending(command);
            void act(command);
          }}
        >
          <label>
            Discussion name (optional)
            <input
              value={author}
              onChange={event => {
                setAuthor(event.target.value);
                setPending(null);
              }}
            />
          </label>
          <label>
            Discussion entry
            <textarea
              required
              value={text}
              onChange={event => {
                setText(event.target.value);
                setPending(null);
              }}
            />
          </label>
          <button disabled={busy || !text}>
            {pending ? 'Reconcile discussion entry' : 'Add discussion entry'}
          </button>
        </form>
      )}
    </div>
  );
}

export function WorkPlanning({
  intentId,
  readOnly = false,
  data,
  busy,
  act,
  exportHistory,
  renderDetails,
  provenance,
  loadItem,
  renderBody,
  renderConversation,
  timelineData,
  initiativeOrigin,
  initiativeVersions,
}: Props & {
  intentId?: string;
  exportHistory: () => Promise<PlanningExport>;
  renderDetails?: (item: PlanningItem, open: boolean) => ReactNode;
  loadItem?: (id: string) => Promise<PlanningItem>;
  renderBody?: (item: PlanningItem, open: boolean) => ReactNode;
  renderConversation?: (item: PlanningItem) => ReactNode;
  timelineData?: PlanningData;
  initiativeOrigin?: AttributedPlanningItem;
  initiativeVersions?: readonly AttributedPlanningItem[];
}) {
  const workHeader = useWorkHeader();
  const initiativeWrites = useRef(
    new Map<string, Extract<PlanningCommand, { action: 'put-planning-item' }>>(),
  );
  const [selected] = useDestination('planningItem');
  const [abandoning, setAbandoning] = useState<PlanningItem>();
  const [abandonReason, setAbandonReason] = useState('');
  const [abandonBusy, setAbandonBusy] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [search, setSearch] = useState(''),
    [initiative, setInitiative] = useState('');
  const [filter, setFilter] = useState<PlanningFilter>('all');
  const [linkedOnly, setLinkedOnly] = useState(!!intentId);
  const [editorOpen, setEditorOpen] = useState(false),
    [loadingItem, setLoadingItem] = useState(false);
  const [editing, setEditing] = useState(''),
    [version, setVersion] = useState(0);
  const [kind, setKind] = useState<PlanningItem['kind']>('issue');
  const [status, setStatus] = useState<PlanningItem['status']>('open');
  const [title, setTitle] = useState(''),
    [body, setBody] = useState(''),
    [parent, setParent] = useState('');
  const [links, setLinks] = useState<string[]>(intentId ? [intentId] : []);
  const [pending, setPending] = useState<Extract<PlanningCommand, { action: 'put-planning-item' }> | null>(
    null,
  );
  const [handoff, setHandoff] = useState('');
  const loadSequence = useRef(0),
    submission = useRef(false);
  const [exporting, setExporting] = useState(false),
    [error, setError] = useState('');
  const items = [...new Map(data.planningItems.map(item => [item.id, item])).values()];
  const groups = planningGroups(items, data.intents, data.lanes ?? []);
  const needle = search.trim().toLowerCase();
  const scopedGroups = groups
    .filter(group => !initiative || group.id === initiative)
    .map(group => ({
      ...group,
      rows: group.rows.filter(
        row =>
          (!linkedOnly || row.intentId === intentId) &&
          (!needle ||
            row.searchText.toLowerCase().includes(needle) ||
            group.title.toLowerCase().includes(needle)),
      ),
    }));
  const countRows = scopedGroups.flatMap(group => group.rows);
  const visibleGroups = scopedGroups.map(group => ({
    ...group,
    rows: group.rows.filter(row => planningRowMatches(row, filter)),
  }));
  const emptyGroups = visibleGroups.filter(group => group.item && !group.rows.length);
  const detailItem =
    items.find(item => item.id === selected) ?? items.find(item => item.intentIds?.includes(selected));
  function href(destination: Parameters<typeof planningDestination>[0]) {
    const url = routeUrlState();
    for (const key of ['intent', 'lane', 'viewId', 'reviewView', 'planningItem', 'planning', 'planningRoute'])
      url.searchParams.delete(key);
    for (const [key, value] of Object.entries(planningDestination(destination)))
      url.searchParams.set(key, value);
    return cleanUrl(url.href);
  }
  const intentHref = (id: string) => href({ kind: 'intent', id });
  const itemHref = (item: PlanningItem) =>
    href({ kind: item.kind === 'initiative' ? 'initiative' : 'planning', id: item.id });
  const listHref = href({ kind: 'list' });
  const confirmed = data.planningItems.find(item => item.operationId === pending?.operationId);
  useEffect(() => {
    if (confirmed) {
      setEditing(confirmed.id);
      setVersion(confirmed.version);
      setPending(null);
    }
  }, [confirmed]);
  function create(nextKind: PlanningItem['kind'], initiativeId = '') {
    ++loadSequence.current;
    setEditing('');
    setVersion(0);
    setKind(nextKind);
    setStatus('open');
    setTitle('');
    setBody('');
    setParent(initiativeId);
    setLinks(intentId ? [intentId] : []);
    setPending(null);
    setError('');
    setLoadingItem(false);
    setEditorOpen(true);
  }
  async function edit(id: string) {
    const sequence = ++loadSequence.current;
    setError('');
    setLoadingItem(true);
    setEditorOpen(true);
    try {
      const item = loadItem ? await loadItem(id) : items.find(item => item.id === id);
      if (sequence !== loadSequence.current || !item) return;
      setEditing(id);
      setVersion(item.version);
      setKind(item.kind);
      setStatus(item.status);
      setTitle(item.title);
      setBody(item.body);
      setParent(item.initiativeId ?? '');
      setLinks(item.intentIds ?? []);
      setPending(null);
    } catch (error) {
      if (sequence === loadSequence.current) setError((error as Error).message);
    } finally {
      if (sequence === loadSequence.current) setLoadingItem(false);
    }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loadingItem || submission.current) return;
    const delegate = (event.nativeEvent as SubmitEvent)?.submitter?.getAttribute('value') === 'delegate';
    const command = pending ?? {
      action: 'put-planning-item' as const,
      operationId: crypto.randomUUID(),
      itemId: editing || crypto.randomUUID(),
      expectedVersion: version,
      kind,
      title,
      body,
      status,
      intentIds: links,
      ...(parent ? { initiativeId: parent } : {}),
    };
    const sequence = loadSequence.current;
    setPending(command);
    setError('');
    submission.current = true;
    try {
      const acknowledgement = await act(command);
      if (acknowledgement?.operationId === command.operationId && sequence === loadSequence.current) {
        setEditing(command.itemId);
        setVersion(command.expectedVersion + 1);
        setPending(current => (current?.operationId === command.operationId ? null : current));
        // A response can overtake the reactive current-only page. Keep this exact
        // item/version for a continued draft, rather than creating a second item.
        if (delegate) setHandoff(command.itemId);
      }
    } catch (error) {
      setError((error as Error).message);
    } finally {
      submission.current = false;
    }
  }
  async function download() {
    setExporting(true);
    setError('');
    try {
      const result = await exportHistory();
      const url = URL.createObjectURL(new Blob([result.json], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setExporting(false);
    }
  }
  async function closeInitiative(
    item: PlanningItem,
    nextStatus: PlanningItem['status'] = 'closed',
    reason?: string,
  ) {
    try {
      // Summary bodies are truncated. Always hydrate before replacing a record.
      const full = loadItem ? await loadItem(item.id) : item;
      const writeKey = JSON.stringify([item.id, nextStatus, reason]);
      const command = initiativeWrites.current.get(writeKey) ?? {
        action: 'put-planning-item',
        operationId: crypto.randomUUID(),
        itemId: full.id,
        expectedVersion: full.version,
        kind: full.kind,
        title: full.title,
        body: full.body,
        status: nextStatus,
        ...(reason !== undefined ? { reason } : {}),
        intentIds: full.intentIds,
        ...(full.initiativeId ? { initiativeId: full.initiativeId } : {}),
      };
      initiativeWrites.current.set(writeKey, command);
      const acknowledgement = await act(command);
      if (acknowledgement?.operationId !== command.operationId)
        return 'The request did not complete. Retry keeps its original operation.';
      initiativeWrites.current.delete(writeKey);
      return null;
    } catch (error) {
      setError((error as Error).message);
      return (error as Error).message;
    }
  }
  const editor = !readOnly && editorOpen && (
    <form
      className="planning-create"
      aria-label={editing ? 'Edit item' : kind === 'issue' ? 'New Intent' : 'New Initiative'}
      onSubmit={save}
    >
      <label>
        Title
        <input
          autoFocus
          required
          disabled={loadingItem}
          value={title}
          onChange={event => {
            setTitle(event.target.value);
            setPending(null);
          }}
        />
      </label>
      <label>
        {kind === 'issue' ? 'Initiative' : 'Parent Initiative'}
        <select
          aria-label={kind === 'issue' ? 'Initiative' : 'Parent Initiative'}
          disabled={loadingItem}
          value={parent}
          onChange={event => {
            setParent(event.target.value);
            setPending(null);
          }}
        >
          <option value="">No Initiative</option>
          {items
            .filter(item => item.kind === 'initiative' && item.id !== editing)
            .map(item => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
        </select>
      </label>
      <label className="planning-wide">
        Details
        <textarea
          aria-label="Details"
          disabled={loadingItem}
          value={body}
          onChange={event => {
            setBody(event.target.value);
            setPending(null);
          }}
        />
      </label>
      <div className="planning-create-actions">
        <Button variant="primary" type="submit" disabled={busy || loadingItem || !title.trim()}>
          {editing ? 'Save' : 'Create'}
        </Button>
        {kind === 'issue' && !editing && (
          <Button
            type="submit"
            value="delegate"
            icon="handoff"
            disabled={busy || loadingItem || !title.trim()}
          >
            Create &amp; hand to an agent
          </Button>
        )}
        <Button
          variant="ghost"
          onClick={() => {
            ++loadSequence.current;
            setEditorOpen(false);
          }}
        >
          Cancel
        </Button>
        {!editing && kind === 'issue' && (
          <span className="planning-create-hint">
            Starts as Planned · In motion begins with its first Lane
          </span>
        )}
        {loadingItem && <span role="status">Loading item…</span>}
      </div>
    </form>
  );
  const renderRow = (row: PlanningRow) => (
    <WorkRow
      key={row.id}
      title={row.title}
      href={row.intentId ? intentHref(row.intentId) : itemHref(items.find(item => item.id === row.itemId)!)}
      tone={row.tone}
      label={row.label}
      fact={<PlanningRowFact row={row} />}
      age={row.at ? <time title={row.at}>{age(row.at, Date.now())}</time> : undefined}
      done={planningRowMatches(row, 'done')}
    />
  );
  const actions = !readOnly && (
    <>
      <Button variant="ghost" icon="initiative" onClick={() => create('initiative')}>
        New Initiative
      </Button>
      <Button variant="primary" icon="plus" onClick={() => create('issue')}>
        New Intent
      </Button>
      <Menu label="⋯" ariaLabel="More planning actions">
        <button disabled={exporting} onClick={() => void download()}>
          Export planning history
        </button>
      </Menu>
    </>
  );
  if (selected && detailItem?.kind === 'initiative')
    return (
      <>
        <InitiativePage
          key={detailItem.id}
          item={detailItem}
          data={data}
          timelineData={timelineData}
          versions={initiativeVersions ?? data.planningItems.filter(version => version.id === detailItem.id)}
          origin={
            initiativeOrigin ??
            (() => {
              const first = data.planningItems.find(item => item.id === detailItem.id && item.version === 1);
              return (
                first && { ...first, actorDisplayName: planningActor(first.operationId, data.hostedEvents) }
              );
            })()
          }
          readOnly={readOnly}
          busy={busy}
          listHref={listHref}
          href={(kind, id) => href({ kind, id })}
          onCreate={(kind, parent) => {
            setHistoryOpen(false);
            create(kind, parent);
          }}
          onEdit={() => {
            setHistoryOpen(false);
            void edit(detailItem.id);
          }}
          onStatus={(status, reason) => closeInitiative(detailItem, status, reason)}
          onExport={() => void download()}
          editor={editor}
          body={renderBody ? renderBody(detailItem, true) : undefined}
          conversation={
            renderConversation ? (
              renderConversation(detailItem)
            ) : (
              <InitiativeConversation
                itemId={detailItem.id}
                data={data}
                act={act}
                busy={busy}
                readOnly={readOnly}
              />
            )
          }
        />
        {error && <ErrorToast>{error}</ErrorToast>}
      </>
    );
  if (selected && detailItem)
    return (
      <section className="planning-board fx-page planning-page">
        <nav className="planning-crumbs" aria-label="Breadcrumb">
          <a href={listHref}>Work</a>
          <span>›</span>
          <a href={listHref}>Planning</a>
          <span>›</span>
          <span title={detailItem.title}>{detailItem.title}</span>
        </nav>
        <PageHead
          title={detailItem.title}
          actions={
            !readOnly && (
              <Button variant="ghost" onClick={() => void edit(detailItem.id)}>
                Edit
              </Button>
            )
          }
        />
        {editor}
        <Panel title="Details">{renderBody ? renderBody(detailItem, true) : <p>{detailItem.body}</p>}</Panel>
        {detailItem.kind === 'initiative' && (
          <Panel title="Intents">
            <PagedList
              rows={groups.find(group => group.id === detailItem.id)?.rows ?? []}
              size={5}
              label="Intents"
              className="fx-wrs"
              render={renderRow}
            />
          </Panel>
        )}
        <Button variant="ghost" onClick={() => setHistoryOpen(!historyOpen)}>
          History
        </Button>
        {historyOpen && (
          <div className="planning-detail-history">
            {provenance ? (
              provenance(detailItem.operationId)
            ) : (
              <PlanningProvenance operationId={detailItem.operationId} data={data} />
            )}
            {!renderDetails &&
              data.planningItems
                .filter(item => item.id === detailItem.id)
                .map(item => (
                  <div key={item.version}>
                    <p>
                      Version {item.version}: {item.title} · {item.status} · {item.at}
                    </p>
                    <p>{item.body}</p>
                  </div>
                ))}
          </div>
        )}
        {renderDetails ? (
          renderDetails(detailItem, historyOpen)
        ) : (
          <PlanningThread itemId={detailItem.id} data={data} busy={busy} readOnly={readOnly} act={act} />
        )}
        {error && <ErrorToast>{error}</ErrorToast>}
      </section>
    );
  return (
    <section
      className={`work-section planning-board${workHeader ? ' fx-page' : ''}`}
      aria-label="Intents and Initiatives"
    >
      {abandoning && (
        <LifecycleDialog
          action="abandon"
          collection="planning"
          reason={abandonReason}
          setReason={setAbandonReason}
          saveFirst={false}
          setSaveFirst={() => {}}
          cascade={false}
          setCascade={() => {}}
          busy={busy || abandonBusy}
          close={() => setAbandoning(undefined)}
          submit={() => {
            setAbandonBusy(true);
            void closeInitiative(abandoning, 'abandoned', abandonReason)
              .then(problem => {
                if (!problem) setAbandoning(undefined);
                else setError(problem);
              })
              .finally(() => setAbandonBusy(false));
          }}
        />
      )}
      <PageHead title="Planning" actions={actions} />
      <div className="planning-list fx-panel">
        <div className="planning-toolbar">
          <div className="planning-filters">
            <Segmented
              label="Planning status"
              value={filter}
              onChange={setFilter}
              options={intentFilters.map(id => ({
                id,
                label: (
                  <>
                    {intentFilterLabels[id]}{' '}
                    <span className="fx-count">
                      {countRows.filter(row => planningRowMatches(row, id)).length}
                    </span>
                  </>
                ),
              }))}
            />
          </div>
          <label className="planning-search">
            <span className="sr-only">Find an Intent or Initiative</span>
            <input
              type="search"
              placeholder="Find an Intent or Initiative"
              value={search}
              onChange={event => setSearch(event.target.value)}
            />
          </label>
          <label className="planning-initiative-filter">
            <span className="sr-only">Initiative</span>
            <select
              aria-label="Initiative"
              value={initiative}
              onChange={event => setInitiative(event.target.value)}
            >
              <option value="">All Initiatives</option>
              {groups
                .filter(group => group.item)
                .map(group => (
                  <option key={group.id} value={group.id}>
                    {group.title}
                  </option>
                ))}
            </select>
          </label>
        </div>
        {editor}
        {handoff && data.intents.some(intent => intent.id === handoff) && (
          <CopyPrompt
            key={handoff}
            request={{ situation: 'start-intent', intentId: handoff }}
            label="Hand to an agent"
            initiallyOpen
            onClose={() => setHandoff('')}
          />
        )}
        {intentId && (
          <label className="lane-select">
            <input
              type="checkbox"
              checked={linkedOnly}
              onChange={event => setLinkedOnly(event.target.checked)}
            />
            Linked to the selected Intent
          </label>
        )}
        {visibleGroups
          .filter(group => group.rows.length)
          .map(group => {
            const motion = group.rows.filter(row => planningRowMatches(row, 'in-motion')).length;
            const done = group.rows.filter(row => planningRowMatches(row, 'done')).length;
            const children = groups.find(value => value.id === group.id)?.rows ?? [];
            const label = group.item
              ? initiativeProgress(group.item, children).label
              : group.id === 'proposed'
                ? 'Proposed'
                : 'Planned';
            return (
              <section key={group.id} className="planning-group">
                <header className="planning-grp">
                  {group.item ? (
                    <a className="planning-group-title" href={itemHref(group.item)}>
                      <Glyph name="initiative" size={16} />
                      {group.title}
                    </a>
                  ) : (
                    <span className="planning-group-title">
                      <Glyph name="initiative" size={16} />
                      {group.title}
                    </span>
                  )}
                  <span className="planning-group-count">
                    {group.rows.length} {group.rows.length === 1 ? 'Intent' : 'Intents'}
                    {motion > 0 && <> · {motion} in motion</>}
                    {done > 0 && <> · {done} done</>}
                  </span>
                  {(group.item || group.id === 'proposed') && (
                    <StatusPill
                      tone={
                        label === 'Abandoned'
                          ? 'stale'
                          : label === 'Done'
                            ? 'passed'
                            : label === 'In motion'
                              ? 'active'
                              : 'plain'
                      }
                    >
                      {label}
                    </StatusPill>
                  )}
                  {group.item && !readOnly && (
                    <Menu label="⋯" ariaLabel={`Actions for ${group.title}`}>
                      <button onClick={() => void edit(group.item!.id)}>Edit</button>
                      <button onClick={() => create('issue', group.id)}>Add Intent</button>
                      <button disabled={busy} onClick={() => void closeInitiative(group.item!)}>
                        Mark done
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => {
                          setAbandonReason('');
                          setAbandoning(group.item!);
                        }}
                      >
                        Abandon…
                      </button>
                    </Menu>
                  )}
                </header>
                <PagedList
                  rows={initiativeRows(group.rows)}
                  size={5}
                  label="Intents"
                  className="fx-wrs"
                  render={renderRow}
                />
              </section>
            );
          })}
        {emptyGroups.length > 0 && (
          <details className="planning-empty-initiatives">
            <summary>
              {emptyGroups.length} {emptyGroups.length === 1 ? 'Initiative' : 'Initiatives'} with no matching
              Intents
            </summary>
            {emptyGroups.map(group => (
              <a key={group.id} href={itemHref(group.item!)}>
                <Glyph name="initiative" size={16} />
                {group.title}
              </a>
            ))}
          </details>
        )}
        {!countRows.filter(row => planningRowMatches(row, filter)).length && (
          <p className="planning-empty">
            {items.length || data.intents.length ? 'No Intents match this view.' : 'No Intents yet.'}
          </p>
        )}
      </div>
      {error && <ErrorToast>{error}</ErrorToast>}
    </section>
  );
}
