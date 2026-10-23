// SPDX-License-Identifier: Apache-2.0
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ForgeError, invariant } from './errors.js';
import { nativeOwner } from './native-source.js';
import { normalizeRoot } from './snapshot.js';
import { workGit } from './work-git.js';
import type { WorkStore } from './work-store.js';
import { Workspace } from './workspace.js';

type SourceContext = {
  startupRoot: string;
  laneId: string;
  laneName?: string;
  sourceRoot?: string;
  workDirectory?: string;
  recordedHead?: string;
  workRevision?: number;
};
export class RoutedSourceError extends ForgeError {
  constructor(
    error: unknown,
    readonly sourceContext: SourceContext,
  ) {
    super(
      error instanceof ForgeError ? error.code : 'INTERNAL_ERROR',
      error instanceof ForgeError ? error.message : 'Forge could not complete the selected source request.',
    );
  }
}

/** Explicit per-call selection, using the original Work owner and ordinary query/artifact owners. */
export class McpSourceRouting {
  private readonly workspaces: Map<string, Workspace>;
  private closed = false;
  constructor(
    readonly startup: Workspace,
    private readonly store?: WorkStore,
  ) {
    this.workspaces = new Map([[startup.root, startup]]);
  }
  async run(
    laneId: string | undefined,
    action: (workspace: Workspace) => object | Promise<object>,
  ): Promise<object> {
    if (laneId === undefined) return action(this.startup);
    let sourceContext: SourceContext = { startupRoot: this.startup.root, laneId };
    try {
      invariant(!this.closed, 'WORKSPACE_CLOSED', 'Workspace is closed.');
      invariant(
        this.store,
        'WORK_DISABLED',
        'Lane source selection requires the existing --work mode. Startup source remains selected when laneId is omitted.',
      );
      // Do not call status: source selection neither recovers journals nor computes Work reviews.
      const data = this.store.load(),
        lane = data.lanes.find(item => item.id === laneId);
      invariant(lane, 'NOT_FOUND', 'Lane not found in this Work owner.');
      const path = this.store.path(lane.id);
      invariant(
        existsSync(path) &&
          lstatSync(path).isDirectory() &&
          !lstatSync(path).isSymbolicLink() &&
          realpathSync(path) === path,
        'LANE_UNAVAILABLE',
        'Lane source directory is unavailable or redirected. Existing work is retained.',
      );
      const root = normalizeRoot(path);
      const sameOwner = this.store.native
        ? nativeOwner(root) === this.store.root
        : join(
            realpathSync(resolve(root, workGit(root, ['rev-parse', '--git-common-dir']).trim())),
            'forge-work',
          ) === this.store.directory;
      invariant(
        sameOwner,
        'LANE_UNAVAILABLE',
        'Lane source belongs to another Work owner. Existing work is retained.',
      );
      sourceContext = {
        ...sourceContext,
        laneName: lane.name,
        sourceRoot: root,
        workDirectory: this.store.directory,
        recordedHead: lane.head,
        workRevision: data.revision,
      };
      let workspace = this.workspaces.get(root);
      if (!workspace) {
        workspace = new Workspace(root);
        this.workspaces.set(root, workspace);
      }
      return { ...(await action(workspace)), sourceContext };
    } catch (error) {
      throw new RoutedSourceError(error, sourceContext);
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.workspaces.values()].map(workspace => workspace.close()));
  }
}
