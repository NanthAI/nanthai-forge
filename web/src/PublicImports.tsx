import { ErrorToast } from './ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { Icon } from './Icons';
import { DetailPanel } from './DetailPanel';
import { useEffect, useState } from 'react';
import { useConvex } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { hostedError } from './snapshot';
import UpstreamRequest from './UpstreamRequest';
import { publicRequestSource } from './upstream-request';

type Page = {
  page: {
    id: string;
    repository: string;
    url: string;
    ref: string;
    head: string;
    importedAt: number;
    checkedAt: number;
    license: { name: string; spdx_id: string } | null;
  }[];
  isDone: boolean;
  continueCursor: string;
  unavailable: number;
};
export default function PublicImports() {
  const client = useConvex(),
    [result, setResult] = useState<Page | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function load(cursor: string | null) {
    setBusy(true);
    setError('');
    try {
      const next = JSON.parse(
        await client.action(api.hosted.discover, { paginationOpts: { cursor, numItems: 12 } }),
      ) as Page;
      setResult(previous => ({
        ...next,
        page: cursor
          ? [...(previous?.page ?? []), ...next.page].filter(
              (item, index, items) => items.findIndex(other => other.id === item.id) === index,
            )
          : next.page,
        unavailable: (cursor ? (previous?.unavailable ?? 0) : 0) + next.unavailable,
      }));
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load(null);
  }, []);
  return (
    <section className="private-imports" aria-label="Recent public imports">
      <div className="section-heading">
        <h2>Recent public imports</h2>
        <button aria-label="Refresh public imports" disabled={busy} onClick={() => void load(null)}>
          <Icon name="activity" />
        </button>
      </div>
      {!result && busy && <p role="status">Loading public imports…</p>}
      {result && (
        <>
          {result.page.length ? (
            <>
              <p className="collection-count">
                {result.page.length} public snapshots ·{' '}
                {new Set(result.page.map(item => item.repository)).size} repositories
              </p>
              <ul className="import-list public-discovery-list">
                {result.page.map(item => (
                  <li key={item.id}>
                    <div>
                      <strong>
                        <a className="public-repository-title" href={`?codescape=${item.id}`}>
                          {item.repository}
                          <Icon name="arrow" />
                        </a>
                      </strong>
                      <small>
                        {item.ref} ·{' '}
                        {item.license?.spdx_id && item.license.spdx_id !== 'NOASSERTION'
                          ? item.license.spdx_id
                          : 'License not identified'}
                      </small>
                      <a className="public-explore-action" href={`?codescape=${item.id}`}>
                        Explore source
                        <Icon name="arrow" />
                      </a>
                      <DetailPanel className="item-provenance" title={<>Source, license & access check</>}>
                        <a href={item.url} target="_blank" rel="noopener noreferrer">
                          Original repository on GitHub
                        </a>
                        <small>
                          Indexed {item.head.slice(0, 12)} ·{' '}
                          {item.license?.spdx_id && item.license.spdx_id !== 'NOASSERTION'
                            ? item.license.spdx_id
                            : 'No identified SPDX license'}
                          <br />
                          Imported {new Date(item.importedAt).toLocaleString()} · Public access checked{' '}
                          {new Date(item.checkedAt).toLocaleString()}
                        </small>
                        <UpstreamRequest
                          source={publicRequestSource({
                            hosted: { upstream: item.url, visibility: 'public' },
                            gitHead: item.head,
                          })}
                        />
                      </DetailPanel>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p>No public imports available on this page.</p>
          )}
          {result.unavailable > 0 && (
            <p role="status">
              {result.unavailable} stored public imports could not be confirmed public and are omitted.
            </p>
          )}
          {!result.isDone && (
            <button disabled={busy} onClick={() => void load(result.continueCursor)}>
              Load more public imports
            </button>
          )}
        </>
      )}
      {error && <ErrorToast>{error}</ErrorToast>}
    </section>
  );
}
