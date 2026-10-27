import { readBrowserSource } from '../browser-source';
import { useReadRetry } from '../ui/read-retry';
import { ErrorToast } from '../ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, useRef } from 'react';
import { useConvex } from 'convex/react';
import type { ChangeMapData } from '../../../src/change-map';
import { hostedError } from '../snapshot';
import { createPortal } from 'react-dom';
import { CodeGraph } from '../CodeGraph';
import { collapseChangeMap } from './change-map-model';
import type { MapSource } from './ChangeMapToggle';
import { Diff, type Comparison } from './Diff';
import '../code.css';
import './change-map.css';
type Props = {
  showDiff?: boolean;
  toolbar?: HTMLElement | null;
  source: MapSource;
  selected: string;
  select: (path: string, node: ChangeMapData['nodes'][number]) => void;
};
type Read = (base: string, head: string, id: string, map: boolean) => Promise<ChangeMapData | string[]>;
export default function ChangeMap(props: Props) {
  const client = useConvex();
  return (
    <MapPanel
      {...props}
      read={async (base, head, _id, map) => {
        let raw: string;
        try {
          raw = await readBrowserSource(client, {
            projectId: props.source.projectId!,
            backupId: props.source.backupId!,
            base,
            head,
            ...(map ? { map: true } : {}),
          });
        } catch (error) {
          if (map && /extra field [`']?map|map.*not.*validator/i.test((error as Error).message))
            throw new Error('Map reader is not available on this server yet.');
          throw new Error(hostedError(error));
        }
        const value = JSON.parse(raw);
        if (!value.available) throw new Error(value.reason);
        if (map) {
          if (!value.map) throw new Error('Map reader is not available on this server yet.');
          return value.map as ChangeMapData;
        }
        return value.paths
          .filter((p: { status: string }) => p.status !== 'unchanged')
          .map((p: { path: string }) => p.path);
      }}
    />
  );
}
function MapPanel({ source, selected, select, read, showDiff, toolbar }: Props & { read: Read }) {
  const readAttempt = useReadRetry();
  const graphHost = useRef<HTMLElement>(null);
  const focusNext = useRef('');
  const [picked, setPicked] = useState<ChangeMapData['nodes'][number]>();
  const [data, setData] = useState<ChangeMapData>();
  const [markers, setMarkers] = useState(new Map<string, string[]>());
  const [error, setError] = useState(''),
    [peerError, setPeerError] = useState('');
  const [retry, setRetry] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // The graph reader is captured once per exact head; coordination follows current peer pins.
  useEffect(() => {
    let current = true;
    setError('');
    void read(source.base, source.head, source.id, true)
      .then(value => {
        if (!current) return;
        const graph = value as ChangeMapData;
        if (graph.head !== source.head || graph.base !== source.base)
          throw new Error('Map source changed. Reopen this page.');
        setData(graph);
      })
      .catch(e => {
        if (current) setError((e as Error).message);
      });
    return () => {
      current = false;
    };
  }, [retry, readAttempt]);
  const peerKey = JSON.stringify(
    (source.peers ?? []).filter(p => p.id !== source.id && !source.exclude?.includes(p.id)),
  );
  useEffect(() => {
    let current = true;
    setMarkers(new Map());
    setPeerError('');
    let cursor = 0;
    const peers = JSON.parse(peerKey) as NonNullable<MapSource['peers']>;
    void Promise.all(
      Array.from({ length: Math.min(4, peers.length) }, async () => {
        while (current && cursor < peers.length) {
          const peer = peers[cursor++]!;
          try {
            const paths = (await read(peer.base, peer.head, peer.id, false)) as string[];
            if (current)
              setMarkers(previous => {
                const next = new Map(previous);
                for (const path of paths)
                  next.set(path, [...new Set([...(next.get(path) ?? []), peer.name])]);
                return next;
              });
          } catch (e) {
            if (current) setPeerError((e as Error).message);
          }
        }
      }),
    );
    return () => {
      current = false;
    };
  }, [peerKey, retry, readAttempt]);
  useEffect(() => {
    if (focusNext.current) {
      graphHost.current
        ?.querySelector<SVGGElement>(`[data-node-id="${CSS.escape(focusNext.current)}"]`)
        ?.focus();
      focusNext.current = '';
    }
  }, [expanded]);
  const visible = data ? collapseChangeMap(data, expanded, markers) : null;
  return (
    <section ref={graphHost} aria-label="Change Map">
      {error ? (
        <ErrorToast read>
          {error}{' '}
          <button type="button" onClick={() => setRetry(n => n + 1)}>
            Retry Map
          </button>
        </ErrorToast>
      ) : !visible ? (
        <p className="fx-map-loading" role="status">
          Reading Map…
        </p>
      ) : (
        <CodeGraph
          minimumHeight={240}
          nodes={visible.nodes}
          edges={visible.edges}
          selected={selected}
          select={id => {
            const group = visible.groups.get(id);
            if (group) {
              focusNext.current = data!.nodes.find(
                n => (n.id.includes('/') ? n.id.split('/')[0] : 'Root files') === group,
              )!.id;
              setExpanded(previous => new Set([...previous, group]));
            } else {
              const node = data!.nodes.find(n => n.id === id);
              if (node) {
                setPicked(node);
                select(id, node);
              }
            }
          }}
        />
      )}
      {visible && (
        <div
          className="fx-map-legend"
          title="Static relative JS/TS imports and re-exports from the base and head. Other relationships are unknown. Node width indicates changed lines; approximate diffstats use the recorded diff budget."
        >
          <span className="fx-map-added">+ Added</span>
          <span className="fx-map-modified">~ Modified</span>
          <span className="fx-map-deleted">− Deleted</span>
          <span>
            <span className="fx-map-peer-dot" aria-hidden="true">
              ●
            </span>{' '}
            Other open Lane
          </span>
        </div>
      )}
      {expanded.size > 0 &&
        toolbar &&
        createPortal(
          <button
            type="button"
            className="fx-map-collapse"
            onClick={() => {
              focusNext.current = `directory:${[...expanded][0]}`;
              setExpanded(new Set());
            }}
          >
            Collapse folders
          </button>,
          toolbar,
        )}
      {showDiff && picked && <MapDiff source={source} node={picked} />}
      {peerError && <ErrorToast read>Other Lanes: {peerError}</ErrorToast>}
    </section>
  );
}

function MapDiff({ source, node }: { source: MapSource; node: ChangeMapData['nodes'][number] }) {
  const client = useConvex();
  return (
    <SelectedDiff
      node={node}
      load={async () => {
        const value = JSON.parse(
          await readBrowserSource(client, {
            projectId: source.projectId!,
            backupId: source.backupId!,
            base: source.base,
            head: source.head,
            file: node.id,
          }),
        );
        if (!value.available) throw new Error(value.reason);
        return value.comparison;
      }}
    />
  );
}
function SelectedDiff({
  node,
  load,
}: {
  node: ChangeMapData['nodes'][number];
  load: () => Promise<Comparison>;
}) {
  const readAttempt = useReadRetry();
  const [value, setValue] = useState<Comparison>(),
    [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    setValue(undefined);
    setError('');
    void load().then(
      v => {
        if (current) setValue(v);
      },
      e => {
        if (current) setError((e as Error).message);
      },
    );
    return () => {
      current = false;
    };
    // Selected file and exact-head panel define this read.
  }, [node.id, readAttempt]);
  return (
    <div className="fx-file-view">
      <div className="fx-file-head">
        <code>{node.id}</code>
      </div>
      {error ? (
        <ErrorToast read>{error}</ErrorToast>
      ) : value ? (
        <Diff comparison={value} status={node.status} file={node.id} mode="unified" />
      ) : (
        <p role="status">Reading diff…</p>
      )}
    </div>
  );
}
