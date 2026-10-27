// SPDX-License-Identifier: Apache-2.0
import { workerPath } from './worker-install.js';
import { Worker } from 'node:worker_threads';
import { normalizeRoot } from './snapshot.js';
import { RepositoryQuery } from './query.js';
import { ForgeError, invariant } from './errors.js';

// This is a rebuildable compiler cache, never a limit on repositories or active jobs.
const idleWorkers = new Map<Workspace, Worker>();
const retainedIdleWorkers = 2;

/** One explicitly selected local repository; callers cannot switch roots through tool arguments. */
export class Workspace {
  readonly root: string;
  private pending: Promise<object> | undefined;
  private worker: Worker | undefined;
  private closed = false;
  constructor(root: string) {
    this.root = normalizeRoot(root);
  }
  query(): RepositoryQuery {
    invariant(!this.closed, 'WORKSPACE_CLOSED', 'Workspace is closed.');
    return new RepositoryQuery(this.root);
  }
  reindex(): Promise<object> {
    if (this.closed) return Promise.reject(new ForgeError('WORKSPACE_CLOSED', 'Workspace is closed.'));
    if (this.pending) return this.pending;
    idleWorkers.delete(this);
    const worker =
      this.worker ??
      new Worker(workerPath(new URL('./index-worker.js', import.meta.url)), { workerData: this.root });
    if (!this.worker) {
      // Idle failures cannot become unhandled errors, and a stopped worker is never reused.
      worker.on('error', () => {
        if (this.worker === worker) {
          this.worker = undefined;
          idleWorkers.delete(this);
        }
        void worker.terminate();
      });
      worker.on('exit', () => {
        if (this.worker === worker) {
          this.worker = undefined;
          idleWorkers.delete(this);
        }
      });
      this.worker = worker;
    }
    worker.ref();
    this.pending = new Promise<object>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        worker.off('message', message);
        worker.off('error', error);
        worker.off('exit', exit);
      };
      const stop = (failure: ForgeError) => {
        cleanup();
        if (this.worker === worker) this.worker = undefined;
        void worker.terminate();
        reject(failure);
      };
      const message = (value: { result?: object; error?: { code: string; message: string } }) => {
        cleanup();
        if (value.error) stop(new ForgeError(value.error.code, value.error.message));
        else if (value.result) resolve(value.result);
        else stop(new ForgeError('INDEX_FAILED', 'Indexer returned an invalid result.'));
      };
      const error = () =>
        stop(new ForgeError('INDEX_FAILED', 'Indexer failed. Previous valid artifact is retained.'));
      const exit = () => stop(new ForgeError('INDEX_STOPPED', 'Indexer stopped before completing.'));
      const timer = setTimeout(
        () =>
          stop(
            new ForgeError('INDEX_TIMEOUT', 'Index exceeded 60 seconds. Retry with a smaller repository.'),
          ),
        60_000,
      );
      worker.once('message', message);
      worker.once('error', error);
      worker.once('exit', exit);
      worker.postMessage({ action: 'index' });
    }).finally(() => {
      this.pending = undefined;
      worker.unref();
      if (!this.closed && this.worker === worker) {
        idleWorkers.set(this, worker);
        while (idleWorkers.size > retainedIdleWorkers) {
          const [owner, old] = idleWorkers.entries().next().value!;
          idleWorkers.delete(owner);
          if (owner.worker === old) owner.worker = undefined;
          void old.terminate();
        }
      }
    });
    return this.pending;
  }
  async close(): Promise<void> {
    this.closed = true;
    idleWorkers.delete(this);
    const worker = this.worker;
    this.worker = undefined;
    await worker?.terminate();
    await this.pending?.catch(() => undefined);
  }
}
