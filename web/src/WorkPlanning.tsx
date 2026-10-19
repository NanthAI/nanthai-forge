import { Menu } from './ui/Menu';
import { ErrorToast } from './ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { PlanningDetail } from './PlanningDetail';
import { intentProgress } from '../../src/work-intent-progress';
import { PlanningIntents } from './PlanningIntents';
import { planningGroups, planningRowMatches, type PlanningFilter } from './planning-rows';
import { PagedList } from './cockpit/ScaleList';
import { Segmented, StatusPill } from './ui/primitives';
import { age } from './ui/status';
import { cleanUrl, routeUrlState } from './shell/location';
import { PageHead } from './shell/Shell';
import { useWorkHeader } from './shell/WorkHeader';
import { Icon } from './Icons';
import { ActionPanel, useDestination } from './WorkspaceUI';
import { useEffect, useState, useRef, type ReactNode } from 'react';
import type { PlanningCommand, PlanningItem, PlanningWrite, WorkData } from '../../src/work-types';

export type PlanningData = Pick<
  WorkData,
  'revision' | 'intents' | 'planningItems' | 'planningComments' | 'hostedEvents'
> & { lanes?: readonly { intentId: string }[] };
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
}: Props & {
  intentId?: string;
  exportHistory: () => Promise<PlanningExport>;
  renderDetails?: (item: PlanningItem, open: boolean) => ReactNode;
  loadItem?: (id: string) => Promise<PlanningItem>;
  renderBody?: (item: PlanningItem, open: boolean) => ReactNode;
}) {
  const workHeader = useWorkHeader();
  const loadSequence = useRef(0),
    [loadingItem, setLoadingItem] = useState(false);
  const [selected, choose] = useDestination('planningItem');
  const [historyItem, setHistoryItem] = useState('');
  const selectionOrigin = useRef<HTMLElement | null>(null);
  function closeDetails() {
    const origin = selectionOrigin.current?.isConnected
      ? selectionOrigin.current
      : document.querySelector<HTMLElement>('.planning-list [aria-expanded="true"]');
    choose('');
    requestAnimationFrame(() => origin?.focus());
  }
  function selectItem(id: string) {
    if (selected === id) return closeDetails();
    if (document.activeElement instanceof HTMLElement && !document.activeElement.closest('.planning-detail'))
      selectionOrigin.current = document.activeElement;
    setHistoryItem('');
    choose(id);
  }
  const [search, setSearch] = useState(''),
    [editorOpen, setEditorOpen] = useState(false);
  const items = [...new Map(data.planningItems.map(item => [item.id, item])).values()].map(item => ({
    ...item,
    intentIds: item.intentIds ?? [],
  }));
  const selectedIntent = data.intents.find(intent => intent.id === selected);
  const detailItem =
    items.find(item => item.id === selected) ??
    items.find(item => item.kind !== 'initiative' && item.intentIds.includes(selected)) ??
    items.find(item => item.intentIds.includes(selected));
  const detailIntent =
    selectedIntent ?? data.intents.find(intent => detailItem?.intentIds.includes(intent.id));
  const detailStatus = detailIntent
    ? intentProgress(
        detailIntent.status,
        (data.lanes ?? []).filter(lane => lane.intentId === detailIntent.id).length,
      )
    : intentProgress(
        detailItem?.status === 'closed' ? 'completed' : 'active',
        detailItem?.status === 'in-progress' ? 1 : 0,
      );
  const [editing, setEditing] = useState(''),
    [version, setVersion] = useState(0);
  const [kind, setKind] = useState<PlanningItem['kind']>('issue'),
    [status, setStatus] = useState<PlanningItem['status']>('open');
  const [title, setTitle] = useState(''),
    [body, setBody] = useState(''),
    [parent, setParent] = useState('');
  const [links, setLinks] = useState<string[]>(intentId ? [intentId] : []);
  const [pending, setPending] = useState<Extract<PlanningCommand, { action: 'put-planning-item' }> | null>(
    null,
  );
  const [filter, setFilter] = useState<PlanningFilter>('all'),
    [initiative, setInitiative] = useState(''),
    [linkedOnly, setLinkedOnly] = useState(!!intentId);
  const [exporting, setExporting] = useState(false),
    [error, setError] = useState(''),
    [hash, setHash] = useState('');
  const current = items.find(item => item.id === editing),
    confirmed = data.planningItems.find(item => item.operationId === pending?.operationId);
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
  const countRows = [
    ...new Map(scopedGroups.flatMap(group => group.rows).map(row => [row.id, row])).values(),
  ];
  const visibleGroups = scopedGroups.map(group => ({
    ...group,
    rows: group.rows.filter(row => planningRowMatches(row, filter)),
  }));
  const emptyGroups = scopedGroups.filter(
    group =>
      group.id &&
      !group.rows.length &&
      !groups.find(value => value.id === group.id)?.rows.length &&
      (!needle || group.title.toLowerCase().includes(needle)) &&
      filter === 'all' &&
      !linkedOnly,
  );
  const intentHref = (id: string) => {
    const url = routeUrlState();
    url.searchParams.set('projectTab', 'intent');
    url.searchParams.set('intent', id);
    url.searchParams.delete('planningItem');
    return cleanUrl(url.href);
  };
  useEffect(() => {
    if (confirmed) {
      setEditing(confirmed.id);
      setVersion(confirmed.version);
      setPending(null);
    }
  }, [confirmed]);
  async function edit(id: string) {
    const sequence = ++loadSequence.current;
    setError('');
    let item = items.find(value => value.id === id);
    if (item && loadItem) {
      setLoadingItem(true);
      try {
        item = await loadItem(id);
      } catch (error) {
        if (sequence === loadSequence.current) {
          setLoadingItem(false);
          setError((error as Error).message);
        }
        return;
      }
      if (sequence !== loadSequence.current) return;
    }
    setLoadingItem(false);
    setEditing(id);
    setVersion(item?.version ?? 0);
    setPending(null);
    setKind(item?.kind ?? 'issue');
    setStatus(item?.status ?? 'open');
    setTitle(item?.title ?? '');
    setBody(item?.body ?? '');
    setParent(item?.initiativeId ?? '');
    setLinks(item?.intentIds ?? (intentId ? [intentId] : []));
  }
  async function download() {
    setExporting(true);
    setError('');
    try {
      const result = await exportHistory();
      const url = URL.createObjectURL(new Blob([result.json], { type: 'application/json' })),
        anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setHash(result.sha256);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExporting(false);
    }
  }
  const editor = readOnly ? undefined : (
    <ActionPanel title={editing ? 'Edit Intent' : 'New Intent'} open={editorOpen} onChange={setEditorOpen}>
      <form
        onSubmit={async event => {
          event.preventDefault();
          if (loadingItem) return;
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
            ...(kind === 'issue' && parent ? { initiativeId: parent } : {}),
          };
          const selection = loadSequence.current;
          setPending(command);
          const acknowledgement = await act(command);
          // Current-only hosted pages may already show a later agent's version. A
          // successful original operation still identifies the item that we saved.
          if (acknowledgement?.operationId === command.operationId && selection === loadSequence.current) {
            setEditing(command.itemId);
            setVersion(command.expectedVersion + 1);
            setPending(current => (current?.operationId === command.operationId ? null : current));
          }
        }}
      >
        <label>
          Planning item
          <select value={editing} onChange={event => edit(event.target.value)}>
            <option value="">New item</option>
            {items.map(item => (
              <option key={item.id} value={item.id}>
                {item.kind === 'issue' ? 'Intent' : 'Initiative'}: {item.title} · version {item.version}
              </option>
            ))}
          </select>
        </label>
        {loadingItem && <p role="status">Loading the complete planning item…</p>}
        <fieldset disabled={loadingItem} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          {current ? (
            <p className="provenance">
              {current.kind === 'issue' ? 'Intent' : 'Initiative'} · loaded version {version}
              {version !== current.version && (
                <>
                  {' '}
                  · Newer version available.{' '}
                  <button type="button" onClick={() => edit(editing)}>
                    Load current planning item
                  </button>
                </>
              )}
            </p>
          ) : (
            <label>
              Item kind
              <select
                value={kind}
                onChange={event => {
                  setKind(event.target.value as typeof kind);
                  setParent('');
                  setPending(null);
                }}
              >
                <option value="issue">Intent</option>
                <option value="initiative">Initiative</option>
              </select>
            </label>
          )}
          <label>
            Title
            <input
              required
              value={title}
              onChange={event => {
                setTitle(event.target.value);
                setPending(null);
              }}
            />
          </label>
          <label>
            Details
            <textarea
              value={body}
              onChange={event => {
                setBody(event.target.value);
                setPending(null);
              }}
            />
          </label>
          <label>
            Status
            <select
              value={status}
              onChange={event => {
                setStatus(event.target.value as typeof status);
                setPending(null);
              }}
            >
              <option value="open">Open</option>
              <option value="in-progress">In progress</option>
              <option value="closed">Closed</option>
            </select>
          </label>
          {kind === 'issue' && (
            <label>
              Parent Initiative (optional)
              <select
                value={parent}
                onChange={event => {
                  setParent(event.target.value);
                  setPending(null);
                }}
              >
                <option value="">None</option>
                {items
                  .filter(item => item.kind === 'initiative')
                  .map(item => (
                    <option key={item.id} value={item.id}>
                      {item.title}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <ActionPanel title={`Linked Intents · ${links.length}`}>
            <fieldset>
              <legend>Linked Intents</legend>
              {!data.intents.length && <p>No Intents yet. You can link them later.</p>}
              {data.intents.map(intent => (
                <label className="publication-draft" key={intent.id}>
                  <input
                    type="checkbox"
                    checked={links.includes(intent.id)}
                    onChange={event => {
                      setLinks(previous =>
                        event.target.checked
                          ? [...previous, intent.id]
                          : previous.filter(id => id !== intent.id),
                      );
                      setPending(null);
                    }}
                  />
                  {intent.outcome}
                </label>
              ))}
            </fieldset>
          </ActionPanel>
          <button disabled={busy || !title.trim()}>{pending ? 'Reconcile item' : 'Save item'}</button>
        </fieldset>
      </form>
    </ActionPanel>
  );
  return (
    <section
      className={`work-section planning-board${workHeader ? ' fx-page' : ''}`}
      aria-label="Intents and Initiatives"
    >
      <PageHead title="Planning" actions={editor} />
      <div className="planning-toolbar">
        <div className="planning-filters">
          <Segmented
            label="Planning status"
            value={filter}
            onChange={setFilter}
            options={(['planned', 'working', 'done', 'all'] as const).map(id => ({
              id,
              label: (
                <>
                  {id === 'planned'
                    ? 'Planned'
                    : id === 'working'
                      ? 'Working'
                      : id === 'done'
                        ? 'Done'
                        : 'All'}{' '}
                  <span className="fx-count">
                    {countRows.filter(row => planningRowMatches(row, id)).length}
                  </span>
                </>
              ),
            }))}
          />
        </div>
        <label>
          <span className="sr-only">Search Intents</span>
          <input
            type="search"
            placeholder="Find an Intent"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </label>
        <label>
          <span className="sr-only">Initiative</span>
          <select
            aria-label="Initiative"
            value={initiative}
            onChange={event => setInitiative(event.target.value)}
          >
            <option value="">All Initiatives</option>
            {groups
              .filter(group => group.id)
              .map(group => (
                <option key={group.id} value={group.id}>
                  {group.title}
                </option>
              ))}
          </select>
        </label>
        {!readOnly && (
          <Menu label="⋯" ariaLabel="More planning actions">
            <button disabled={exporting} onClick={() => void download()}>
              Export planning history
            </button>
          </Menu>
        )}
      </div>
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
      <div className={`planning-layout ${selected ? 'has-selection' : ''}`}>
        <div className="planning-list">
          <div className="planning-columns">
            <span>Intent</span>
            <span>Status</span>
          </div>
          {emptyGroups.length > 0 && (
            <details className="planning-empty-initiatives">
              <summary>
                {emptyGroups.length} {emptyGroups.length === 1 ? 'Initiative' : 'Initiatives'} with no
                matching Intents
              </summary>
              {emptyGroups.map(group => (
                <button
                  key={group.id}
                  aria-expanded={selected === group.id}
                  aria-controls="planning-detail"
                  onClick={() => selectItem(group.id)}
                >
                  <Icon name="initiative" />
                  {group.title}
                </button>
              ))}
            </details>
          )}
          {visibleGroups
            .filter(group => group.rows.length)
            .map(group => (
              <section key={group.id} className="planning-group">
                <header>
                  <button
                    className="text-button"
                    aria-expanded={selected === group.id}
                    aria-controls="planning-detail"
                    disabled={!group.id}
                    onClick={() => selectItem(group.id)}
                  >
                    <Icon name="initiative" />
                    {group.title}
                  </button>
                  <span>
                    {group.rows.length} {group.rows.length === 1 ? 'Intent' : 'Intents'}
                    {group.rows.some(row => planningRowMatches(row, 'working')) && (
                      <> · {group.rows.filter(row => planningRowMatches(row, 'working')).length} working</>
                    )}
                  </span>
                </header>
                <PagedList
                  rows={group.rows}
                  size={5}
                  label="Intents"
                  className="planning-linked-intents"
                  render={row => (
                    <li key={row.id} data-selected={selected === (row.intentId ?? row.itemId)}>
                      <button
                        className="planning-row-title"
                        aria-expanded={selected === (row.intentId ?? row.itemId)}
                        aria-controls="planning-detail"
                        onClick={() => selectItem((row.intentId ?? row.itemId)!)}
                      >
                        {row.title}
                      </button>
                      <StatusPill
                        tone={
                          row.label === 'Planned' || row.label === 'Abandoned'
                            ? 'plain'
                            : row.label === 'Working'
                              ? 'active'
                              : 'passed'
                        }
                      >
                        {row.label}
                      </StatusPill>
                    </li>
                  )}
                />
              </section>
            ))}
        </div>
        {selected && (
          <PlanningDetail
            onClose={closeDetails}
            title={
              <>
                <Icon name="intent" />
                {detailIntent?.outcome ?? detailItem?.title}
              </>
            }
          >
            {[detailItem]
              .filter((item): item is NonNullable<typeof item> => !!item)
              .map(item => (
                <article className="work-note" key={item.id}>
                  {renderBody ? renderBody(item, true) : <p>{item.body}</p>}
                  <div className="planning-detail-meta">
                    {item.initiativeId && (
                      <>
                        <button className="text-button" onClick={() => choose(item.initiativeId!)}>
                          {items.find(parent => parent.id === item.initiativeId)?.title ??
                            'Linked Initiative'}
                        </button>
                        <span>·</span>
                      </>
                    )}
                    <span>{detailStatus}</span>
                    <span>·</span>
                    <time title={item.at}>updated {age(item.at, Date.now())}</time>
                    <span>·</span>
                    <button
                      className="text-button"
                      aria-expanded={historyItem === selected}
                      onClick={() => setHistoryItem(historyItem === selected ? '' : selected)}
                    >
                      History
                    </button>
                  </div>
                  <div className="planning-detail-actions">
                    {detailIntent && (
                      <a className="fx-btn fx-btn-primary" href={intentHref(detailIntent.id)}>
                        Open Intent →
                      </a>
                    )}
                    {!readOnly && (
                      <button
                        className="text-button"
                        onClick={() => {
                          void edit(item.id);
                          setEditorOpen(true);
                        }}
                      >
                        Edit item
                      </button>
                    )}
                  </div>
                  {historyItem === selected && (
                    <div className="planning-detail-history">
                      {provenance ? (
                        provenance(item.operationId)
                      ) : (
                        <PlanningProvenance operationId={item.operationId} data={data} />
                      )}
                    </div>
                  )}
                  {item.kind === 'initiative' && (
                    <ul>
                      {items
                        .filter(child => child.initiativeId === item.id)
                        .map(child => (
                          <li key={child.id}>
                            <button className="text-button" onClick={() => choose(child.id)}>
                              <Icon name="issue" />
                              {child.title}
                            </button>{' '}
                            · {child.status}
                          </li>
                        ))}
                    </ul>
                  )}
                  {item.intentIds.length > 1 && (
                    <PlanningIntents
                      ids={item.intentIds}
                      intents={data.intents}
                      lanes={data.lanes ?? []}
                      href={intentHref}
                    />
                  )}
                  {renderDetails ? (
                    renderDetails(item, historyItem === selected)
                  ) : (
                    <>
                      {historyItem === selected && (
                        <div className="planning-detail-history">
                          {data.planningItems
                            .filter(value => value.id === item.id)
                            .map(value => (
                              <div key={value.version}>
                                <p>
                                  Version {value.version}: {value.title} · {value.status} · {value.at}
                                </p>
                                <p>{value.body}</p>
                                <p className="provenance">
                                  Intent IDs: {value.intentIds.join(', ') || 'None'} · Initiative:{' '}
                                  {value.initiativeId ?? 'None'}
                                </p>
                                <PlanningProvenance operationId={value.operationId} data={data} />
                              </div>
                            ))}
                        </div>
                      )}
                      <PlanningThread
                        itemId={item.id}
                        data={data}
                        busy={busy}
                        act={act}
                        readOnly={readOnly}
                      />
                    </>
                  )}
                </article>
              ))}
          </PlanningDetail>
        )}
      </div>
      {!visibleGroups.some(group => group.rows.length) && !emptyGroups.length && (
        <p>{items.length ? 'No Intents match this view.' : 'No Intents yet.'}</p>
      )}
      {hash && (
        <p className="provenance">
          Private JSON export · SHA-256 <code>{hash}</code>
        </p>
      )}
      {error && <ErrorToast>{error}</ErrorToast>}
    </section>
  );
}
