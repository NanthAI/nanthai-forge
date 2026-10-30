import { gitlinkCommit } from './gitlink.js';
// SPDX-License-Identifier: Apache-2.0
import { readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { workGit } from './work-git.js';
import type { ModalPlan } from './modal-plan.js';

/** Hash exact bytes directly: Git attributes, autocrlf, clean filters and hooks cannot rewrite source. */
export function commitActionsSnapshot(plan: ModalPlan, generated: Map<string, string>, git = workGit) {
  const stateBytes = readFileSync(join(plan.output, 'modal-state.json'));
  invariant(digest(stateBytes) === plan.head, 'EVIDENCE_CHANGED', 'Actions source State digest changed.');
  const state = JSON.parse(stateBytes.toString()) as {
    files: { path: string; blob: string; mode: string }[];
  };
  git(plan.source, ['init', '--template=', '--initial-branch=forge-export']);
  git(plan.source, ['read-tree', '--empty']);
  const entries: string[] = [];
  for (const file of state.files) {
    if (generated.has(file.path)) continue;
    const bytes =
      file.mode === 'symlink'
        ? Buffer.from(readlinkSync(join(plan.source, file.path)))
        : readFileSync(join(plan.source, file.path));
    invariant(digest(bytes) === file.blob, 'EVIDENCE_CHANGED', 'Actions exported source bytes changed.');
    const hash =
      file.mode === 'gitlink'
        ? gitlinkCommit(bytes)
        : git(plan.source, ['hash-object', '--no-filters', '-w', '--stdin'], bytes).trim();
    const mode =
      file.mode === 'gitlink'
        ? '160000'
        : file.mode === 'symlink'
          ? '120000'
          : file.mode === 'executable'
            ? '100755'
            : '100644';
    entries.push(`${mode} ${hash}\t${file.path}\0`);
  }
  for (const [path, text] of generated) {
    const hash = git(plan.source, ['hash-object', '--no-filters', '-w', '--stdin'], text).trim();
    entries.push(`100644 ${hash}\t${path}\0`);
  }
  git(plan.source, ['update-index', '-z', '--index-info'], entries.join(''));
  const tree = git(plan.source, ['write-tree']).trim();
  return git(plan.source, ['commit-tree', tree, '-m', `Forge check ${plan.runId} (${plan.pin})`]).trim();
}
