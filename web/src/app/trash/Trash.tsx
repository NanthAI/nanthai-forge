// SPDX-License-Identifier: Apache-2.0
// Account > Projects > Trash (Item 8fba39a4, SPEC-01-trash): the projects the person moved to the trash, soonest to go
// first, with Restore, Delete forever and Empty trash. One bounded read per visit (projectBackups.list, removed only, 50
// rows a page), read again when the tab comes back into view: no subscription, no polling, idle 0. Each action is one
// retry-safe mutation; Empty trash only prepares the existing delete request and opens its page.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConvex } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import { Key, Region } from '../../ds';
import { hostedError } from '../../snapshot';
import { AccountStrip } from '../projects/AccountStrip';
import { deleteRequestHref, hrefFor } from '../paths';
import { Head } from '../Place';
import { navigate } from '../router';
import { useLifecycle } from './lifecycle';
import { DeleteForever } from './DeleteForever';
import { TrashRow, type RowAction } from './TrashRow';
import { Toasts, useToast } from './Toasts';
import { listed, sizeText, soonest, trashSentence, type TrashProject } from './trash-model';
import { useCommandChip } from './CommandChip';
import '../projects/projects.css';
import './trash.css';

const PAGE = 50;
type Read =
  | { state: 'loading' }
  | { state: 'failed'; last?: Shown | undefined; at?: number | undefined }
  | { state: 'ok'; data: Shown };
type Shown = { projects: readonly TrashProject[]; more: boolean };

function useTrashRead() {
  const client = useConvex();
  const [read, setRead] = useState<Read>({ state: 'loading' });
  const last = useRef<{ data: Shown; at: number } | undefined>(undefined);
  const cursor = useRef<string | null>(null);
  const page = useCallback(
    (from: string | null) => {
      void client
        .query(api.projectBackups.list, { removed: true, paginationOpts: { cursor: from, numItems: PAGE } })
        .then(result => {
          const data = {
            projects: [...(from && last.current ? last.current.data.projects : []), ...result.page],
            more: !result.isDone,
          };
          cursor.current = result.isDone ? null : result.continueCursor;
          last.current = { data, at: Date.now() };
          setRead({ state: 'ok', data });
        })
        .catch(() => setRead({ state: 'failed', last: last.current?.data, at: last.current?.at }));
    },
    [client],
  );
  const first = useCallback(() => page(null), [page]);
  useEffect(() => {
    first();
    const shown = () => {
      if (document.visibilityState === 'visible') first();
    };
    document.addEventListener('visibilitychange', shown);
    return () => document.removeEventListener('visibilitychange', shown);
  }, [first]);
  return { read, reread: first, showMore: () => cursor.current && page(cursor.current) };
}

export default function Trash() {
  const client = useConvex();
  const { read, reread, showMore } = useTrashRead();
  const run = useLifecycle();
  const empty = useRef<string | null>(null);
  const actions: Actions = {
    restore: async project => {
      const receipt = await run('restore', { id: project.id, revision: project.revision });
      reread();
      // No receipt: another tab had already restored it, so this call offers no Undo (Item 966cb821).
      return receipt
        ? () =>
            run('trash', {
              id: project.id,
              revision: receipt.revision,
              afterRestore: receipt.restoreId,
            }).then(reread)
        : undefined;
    },
    forever: async (project, typed) => {
      await run('delete', { id: project.id, revision: project.revision }, typed);
      reread();
    },
    retry: async project => {
      await run('delete', { id: project.id, revision: project.revision });
      reread();
    },
    empty: async () => {
      empty.current ??= crypto.randomUUID();
      const prepared = await client.mutation(api.projectDeleteRequests.prepare, {
        operationId: empty.current,
        select: { trash: true },
      });
      empty.current = null;
      navigate(deleteRequestHref((JSON.parse(prepared) as { id: string }).id));
    },
  };
  return <TrashView read={read} retry={reread} showMore={showMore} now={Date.now()} actions={actions} />;
}

export type Actions = {
  /** Resolves with an Undo for the toast, or none when the project was already restored. */
  restore: (project: TrashProject) => Promise<(() => Promise<unknown>) | undefined>;
  forever: (project: TrashProject, typed: string) => Promise<void>;
  retry: (project: TrashProject) => Promise<void>;
  empty: () => Promise<void>;
};

const projectsHref = hrefFor({ frame: 'account', place: 'projects' });
const trail = [
  { label: 'Account', href: projectsHref },
  { label: 'Projects', href: projectsHref },
  { label: 'Trash' },
];

export function TrashView({
  read,
  retry,
  showMore,
  now,
  actions,
}: {
  read: Read;
  retry: () => void;
  showMore?: (() => void) | undefined;
  now: number;
  actions: Actions;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [forever, setForever] = useState<TrashProject | null>(null);
  const [emptying, setEmptying] = useState(false);
  const { toast, show, clear } = useToast();
  const keep = useRef(new Set<string>());
  const data = read.state === 'ok' ? read.data : read.state === 'failed' ? read.last : undefined;
  const rows = useMemo(() => (data ? soonest(listed(data.projects, keep.current, now)) : []), [data, now]);
  const act = (action: RowAction, project: TrashProject) => {
    if (action === 'forever') return setForever(project);
    setBusy(project.id);
    const done =
      action === 'restore'
        ? actions
            .restore(project)
            .then(undo =>
              undo
                ? show(
                    `Restored ${project.name}. Other people's access, runners and tokens did not come back.`,
                    undo,
                  )
                : show(`${project.name} was already restored.`),
            )
        : actions.retry(project).then(() => show('Removal started again from where it stopped.'));
    done.catch(failure => show(hostedError(failure))).finally(() => setBusy(null));
  };
  const empty = () => {
    setEmptying(true);
    actions.empty().catch(failure => {
      show(hostedError(failure));
      setEmptying(false);
    });
  };
  const chip = useCommandChip();
  // The loading rows draw after 300 ms; a quick read never flashes them. The timer runs only while loading.
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (read.state !== 'loading') return setLate(false);
    const timer = setTimeout(() => setLate(true), 300);
    return () => clearTimeout(timer);
  }, [read.state]);
  const sentence = data ? trashSentence(rows, data.more, now) : null;
  const head = (
    <Head
      trail={trail}
      sentence={
        read.state === 'loading' ? (
          'The trash.'
        ) : sentence ? (
          <>
            <b>{sentence.bold}</b> {sentence.rest}
          </>
        ) : (
          'The trash could not be read.'
        )
      }
    >
      {rows.length ? (
        <Key size="sm" kind="danger" disabled={emptying} onClick={empty}>
          Empty trash
        </Key>
      ) : null}
      {chip.key}
    </Head>
  );
  return (
    <div className="trash-screen account-projects" data-trash>
      <AccountStrip current="trash" />
      {head}
      {chip.output}
      {read.state === 'failed' ? (
        <div className="notice" data-st="failed" role="status">
          <p>
            The trash could not be read just now. What was last shown stays here
            {read.at
              ? `, from ${new Date(read.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
              : ''}
            . Nothing was deleted or restored.
          </p>
          <Key size="sm" onClick={retry}>
            Retry
          </Key>
        </div>
      ) : null}
      {read.state === 'loading' ? (
        late ? (
          <div className="sk-rows" role="status" aria-busy="true">
            <span className="sr">Loading the trash.</span>
            <div className="skrow">
              <span className="sk" />
              <span className="sk" />
            </div>
            <div className="skrow">
              <span className="sk" />
              <span className="sk" />
            </div>
            <div className="skrow">
              <span className="sk" />
              <span className="sk" />
            </div>
          </div>
        ) : null
      ) : data && !rows.length ? (
        <Region title="In the trash" weight="ref">
          {data.more ? (
            <div className="quietline proj-more">
              <span>Nothing to show on this page; the trash has more.</span>
              {showMore ? (
                <Key size="sm" onClick={showMore}>
                  Show {PAGE} more
                </Key>
              ) : null}
            </div>
          ) : (
            <p className="quietline">Nothing in the trash.</p>
          )}
        </Region>
      ) : data ? (
        <Region
          title="In the trash"
          weight="watch"
          count={rows.length}
          hint={data.more ? 'soonest first of those shown' : 'soonest to go first'}
        >
          <div className="th tr" aria-hidden="true">
            <span>Project</span>
            <span>Time left</span>
            <span className="r">Size</span>
            <span />
          </div>
          {rows.map(project => (
            <TrashRow key={project.id} project={project} now={now} busy={busy === project.id} act={act} />
          ))}
          {data.more ? (
            <div className="quietline proj-more">
              <span>{rows.length.toLocaleString()} shown; the trash has more.</span>
              {showMore ? (
                <Key size="sm" onClick={showMore}>
                  Show {PAGE} more
                </Key>
              ) : null}
            </div>
          ) : null}
        </Region>
      ) : null}
      {forever ? (
        <DeleteForever
          name={forever.name}
          confirm={forever.slug ?? forever.name}
          size={sizeText(forever)}
          remove={async typed => {
            keep.current.add(forever.id);
            await actions.forever(forever, typed);
            setForever(null);
          }}
          close={() => setForever(null)}
        />
      ) : null}
      <Toasts toast={toast} onGone={clear} />
    </div>
  );
}
