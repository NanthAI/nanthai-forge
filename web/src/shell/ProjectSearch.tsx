import { readBrowserSource } from '../browser-source';
import { useReadRetry } from '../ui/read-retry';
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useMemo, useState } from 'react';
import { useConvex, useQuery as useHostedQuery } from 'convex/react';
import type { Id } from '../../../convex/_generated/dataModel';
import type { CockpitWork } from '../cockpit/model';
import { useWorkRecords, workIndex, type WorkIndexWorkspace } from '../hosted-work-index';
import type { MoveRecord } from '../cockpit/now-model';
import { Glyph } from '../ui/Glyph';
import { SearchPalette } from './SearchPalette';
import { searchHref, workSearchItems, type SearchItem } from './search-model';

type Props = { project: string; projectId: Id<'hostedProjects'> };
export function ProjectSearch(props: Props) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen(value => !value);
      }
    };
    const show = () => setOpen(true);
    addEventListener('forge:search', show);
    addEventListener('keydown', shortcut);
    return () => {
      removeEventListener('keydown', shortcut);
      removeEventListener('forge:search', show);
    };
  }, []);
  return (
    <>
      <button
        type="button"
        className="fx-search-trigger"
        aria-label="Search project"
        aria-keyshortcuts="Meta+K Control+K"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <Glyph name="search" size={14} />
        <span>Search project</span>
        <kbd>⌘K</kbd>
      </button>
      {open && (
        <HostedSearch projectId={props.projectId} project={props.project} close={() => setOpen(false)} />
      )}
    </>
  );
}
function fileItems(paths: string[], pins: Record<string, string> = {}): SearchItem[] {
  return paths.map(path => ({
    id: `file:${path}`,
    kind: 'File',
    title: path,
    href: searchHref(true, { projectTab: 'delivery', file: path, ...pins }),
  }));
}
function HostedSearch({
  projectId,
  project,
  close,
}: {
  projectId: Id<'hostedProjects'>;
  project: string;
  close: () => void;
}) {
  const readAttempt = useReadRetry();
  const raw = useHostedQuery(workIndex.workspace, { projectId });
  const workspace = useMemo(() => (raw ? (JSON.parse(raw) as WorkIndexWorkspace) : null), [raw]);
  const intents = useWorkRecords<CockpitWork['intents'][number]>(projectId, workspace, 'intents');
  const lanes = useWorkRecords<CockpitWork['lanes'][number]>(projectId, workspace, 'lanes');
  const views = useWorkRecords<CockpitWork['views'][number]>(projectId, workspace, 'views');
  const channels = useWorkRecords<{ name: string; head: string }>(projectId, workspace, 'channels');
  const hostedMoves = useWorkRecords<MoveRecord & { head: string }>(projectId, workspace, 'hostedChannels');
  const sourceHead =
    hostedMoves.records.find(move => move.channel === 'main')?.head ??
    channels.records.find(channel => channel.name === 'main')?.head ??
    workspace?.sourceHead;
  const client = useConvex();
  const [files, setFiles] = useState<SearchItem[]>([]),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!workspace || !sourceHead || !channels.complete || !hostedMoves.complete) return;
    let active = true;
    setFiles([]);
    setError('');
    setLoading(true);
    void readBrowserSource(client, {
      projectId,
      backupId: workspace.backupId,
      base: sourceHead,
      head: sourceHead,
    })
      .then(raw => {
        if (!active) return;
        const result = JSON.parse(raw) as { available: boolean; paths?: { path: string }[] };
        if (result.available && result.paths)
          setFiles(
            fileItems(
              result.paths.map(file => file.path),
              { sourceHead, sourceBackup: workspace.backupId },
            ),
          );
        else setError('File search is unavailable for this checkpoint.');
      })
      .catch(() => {
        if (active) setError('File search unavailable. Close and reopen search to retry.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [
    client,
    projectId,
    workspace?.backupId,
    sourceHead,
    channels.complete,
    hostedMoves.complete,
    readAttempt,
  ]);
  const items = useMemo(
    () => [
      ...workSearchItems(
        { intents: intents.records, lanes: lanes.records, views: views.records, runs: [] },
        true,
      ),
      ...files,
    ],
    [intents.records, lanes.records, views.records, files],
  );
  return (
    <SearchPalette
      project={project}
      source={{ items, loading: loading || intents.loading || lanes.loading || views.loading, error }}
      open
      close={close}
    />
  );
}
