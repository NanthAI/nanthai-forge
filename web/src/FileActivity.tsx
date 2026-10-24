// SPDX-License-Identifier: Apache-2.0
import { type Status } from './api';
export function FileActivity({ file, status }: { file: string; status: Status | null }) {
  const upstream = status?.hosted?.upstream;
  return (
    <section className="file-activity">
      <h3>History & changes</h3>
      <p>
        This graph retains the indexed source snapshot. File history is available at its upstream repository.
      </p>
      {upstream && /^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/.test(upstream) && status?.gitHead && (
        <a
          className="button-link"
          href={`${upstream.replace(/\/$/, '')}/commits/${encodeURIComponent(status.gitHead)}/${file.split('/').map(encodeURIComponent).join('/')}`}
          target="_blank"
          rel="noreferrer noopener"
        >
          View file history on GitHub
        </a>
      )}
      <div className="inspector-section">
        <h3>Inspected source</h3>
        <small>
          {status?.freshness === 'current'
            ? 'Matches the current index'
            : 'Source freshness unavailable or changed'}
        </small>
      </div>
    </section>
  );
}
