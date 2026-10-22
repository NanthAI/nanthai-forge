// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkEnvironment, checkProcessEnvironment } from './check-environment.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import type { NativeSource } from './native-source.js';
import type { WorkStore } from './work-store.js';
import type { Check, Lane } from './work-types.js';

export type PreviewCheck = Pick<Check, 'name' | 'executable' | 'args'> &
  Partial<Pick<Check, 'env' | 'credentials'>>;
export type PreviewObservation = { status: 'passed' | 'failed' | 'text-conflict'; errors: string[] };

/** Explicitly marked definitions win. Package static scripts are the repository's
 * existing fast-check convention; never invoke verify, install or a remote backend. */
export function previewChecks(source: NativeSource, main: string, checks: Check[]): PreviewCheck[] {
  const marked = checks.filter(check => check.static);
  if (marked.length) return marked;
  const file = source.state(main).files.find(file => file.path === 'package.json');
  const scripts = file ? JSON.parse(source.object(file.blob).toString('utf8')).scripts : undefined;
  return ['typecheck', 'lint']
    .filter(name => typeof scripts?.[name] === 'string')
    .map(name => ({
      name,
      executable: 'npm',
      args: ['--ignore-scripts', 'run', name],
    }));
}

/** A preview owns every writable source/dependency byte. Dependency preparation
 * is local only, and requires identical package and lock bytes. */
export class PreviewChecks {
  readonly directory = mkdtempSync(join(tmpdir(), 'forge-integration-'));
  private dependencies: { signature: string; path: string } | undefined;
  constructor(
    private readonly store: WorkStore,
    private readonly source: NativeSource,
    private readonly lanes: Lane[],
    private readonly checks: PreviewCheck[],
  ) {}
  run(head: string): PreviewObservation {
    const run = mkdtempSync(join(this.directory, 'run-')),
      workspace = join(run, 'workspace');
    try {
      this.source.materialize(head, workspace, false);
      this.prepareDependencies(workspace);
      for (const check of this.checks) {
        const environment = checkProcessEnvironment(check as Check, checkEnvironment(), run);
        environment.prepare();
        const result = spawnSync(check.executable, check.args, {
          cwd: workspace,
          env: environment.env,
          encoding: 'utf8',
          maxBuffer: 32 * 1024 * 1024,
        });
        invariant(
          !result.error && !result.signal,
          'INTEGRATION_CHECK_ERROR',
          `Static check ${check.name} could not complete: ${result.error?.message ?? result.signal}`,
        );
        if (result.status !== 0)
          return {
            status: 'failed',
            errors: [
              `${check.name} exited ${result.status}`,
              ...`${result.stdout}\n${result.stderr}`.split(/\r?\n/).filter(Boolean).slice(0, 12),
            ],
          };
      }
      return { status: 'passed', errors: [] };
    } finally {
      rmSync(run, { recursive: true, force: true });
    }
  }
  private prepareDependencies(workspace: string) {
    const signature = (path: string) =>
      ['package.json', 'package-lock.json']
        .map(name => {
          const file = join(path, name);
          return existsSync(file) ? digest(readFileSync(file)) : null;
        })
        .join(':');
    if (!existsSync(join(workspace, 'package-lock.json'))) return;
    const selected = signature(workspace);
    if (this.dependencies?.signature !== selected) {
      const candidate = [
        process.cwd(),
        this.store.root,
        ...this.lanes.map(lane => this.store.path(lane.id)),
      ].find(path => existsSync(join(path, 'node_modules')) && signature(path) === selected);
      invariant(
        candidate,
        'INTEGRATION_DEPENDENCIES_UNAVAILABLE',
        'No prepared local dependencies match the pinned package and lockfile. No install or network request was made.',
      );
      const path = join(mkdtempSync(join(this.directory, 'deps-')), 'node_modules');
      cpSync(join(candidate, 'node_modules'), path, { recursive: true, verbatimSymlinks: true });
      this.dependencies = { signature: selected, path };
    }
    // Shared only inside this disposable preview, never linked to a retained Lane.
    symlinkSync(this.dependencies.path, join(workspace, 'node_modules'), 'dir');
  }
  dispose() {
    rmSync(this.directory, { recursive: true, force: true });
  }
}
