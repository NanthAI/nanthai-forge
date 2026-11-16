// SPDX-License-Identifier: Apache-2.0
import { countLabel } from '../ui/count';
import { ErrorToast } from '../ui/Toast';

/** Import progress for a public repository preview. */
export function Importing({
  repository,
  phase,
  processed,
  total,
  error,
  retry,
  back,
}: {
  repository?: string;
  phase?: string;
  processed?: number;
  total?: number;
  error?: string;
  retry?: () => void;
  back: () => void;
}) {
  const share = total ? Math.min(100, Math.round(((processed ?? 0) / total) * 100)) : 0;
  return (
    <section className="fx-import">
      <p className="fx-import-status">{error ? '' : 'Reading the repository'}</p>
      <h1 className="fx-import-repo">{repository ?? 'Connecting…'}</h1>
      <div
        className="fx-progress"
        role="progressbar"
        aria-valuenow={share}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span
          style={{ width: `${error ? 100 : total ? share : 8}%` }}
          className={error ? 'fx-progress-bad' : undefined}
        />
      </div>
      {error ? (
        <ErrorToast error={error} {...(retry ? { retry } : {})} />
      ) : (
        <p className="fx-import-note" role="status">
          {total
            ? `${phase ?? 'indexing'} · ${processed ?? 0} of ${countLabel(total, 'file')}`
            : `${phase ?? 'starting'}…`}
        </p>
      )}
      <div className="fx-import-try">
        <button type="button" onClick={back}>
          Choose another repository
        </button>
      </div>
    </section>
  );
}
