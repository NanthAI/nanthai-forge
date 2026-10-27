import { semanticCheckCommand } from './semantic-check-command.js';
// SPDX-License-Identifier: Apache-2.0
import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SourceWorkerReader, type SourceWorkerTransport } from './hosted-source-worker-reader.js';
import { parseNativeState } from './native-state-format.js';
import { hostedActionsRecipeSchema, hostedActionsRuntime, type ActionsExport } from './hosted-actions.js';
import { checkPin } from './hosted-check.js';
import { digest } from './hash.js';
import type { HostedCheckDispatch } from './hosted-check-controller.js';
import { githubActionsWorkflow } from './github-actions-workflow.js';
import { hostedActionsGit } from './hosted-actions-git.js';
import { invariant } from './errors.js';

/** Fixed source-worker export. Hash-verified R2 bytes go straight to bare Git
 * objects; source is never checked out and no project code runs here. */
export async function exportHostedActions(
  input: HostedCheckDispatch,
  transport: SourceWorkerTransport,
  progress: () => Promise<void> = async () => {},
) {
  invariant(
    input.configuration.provider === 'github-actions' &&
      input.plan &&
      input.planDigest &&
      input.planDigest === checkPin(input.plan) &&
      checkPin(input.configuration) === input.request.expectedConfiguration &&
      input.check.id === input.request.checkId &&
      input.check.definition === input.request.expectedDefinition &&
      input.configuration.environmentFingerprint === input.request.expectedEnvironment &&
      input.configuration.runtime === hostedActionsRuntime,
    'RUNNER_UNAVAILABLE',
    'Select the pinned Actions worker runtime and prepared plan.',
  );
  const root = await mkdtemp(join(tmpdir(), 'forge-actions-export-'));
  try {
    const cache = join(root, 'source-cache');
    await mkdir(cache, { mode: 0o700 });
    const reader = new SourceWorkerReader(cache, transport, progress);
    await reader.resolveMany([
      input.request.expectedHead,
      input.plan.manifest.sha256,
      input.plan.selection.sha256,
    ]);
    const state = parseNativeState(await readFile(join(cache, input.request.expectedHead)));
    const recipe = hostedActionsRecipeSchema.parse(await reader.json(input.plan.manifest));
    const { pin, ...recipePins } = recipe;
    const selection = await reader.json(input.plan.selection);
    const expectedCommand = [
      /(?:^|\/)node$/.test(input.check.executable) ? 'node' : input.check.executable,
      ...input.check.args,
    ];
    const standard =
      expectedCommand[0] === 'node' &&
      JSON.stringify(input.check.args) === JSON.stringify(['scripts/forge-check.mjs']);
    invariant(
      pin === checkPin(recipePins) &&
        recipe.head === input.request.expectedHead &&
        recipe.definition === input.check.definition &&
        checkPin(selection) === checkPin(recipe.selection) &&
        recipe.standard === standard &&
        checkPin(recipe.command) === checkPin(expectedCommand) &&
        input.plan.head === recipe.head &&
        input.plan.definition === recipe.definition &&
        input.plan.runtime === input.configuration.runtime &&
        input.plan.environmentFingerprint === input.configuration.environmentFingerprint &&
        input.plan.shardCount === recipe.groups.length + 1,
      'EVIDENCE_CHANGED',
      'Actions recipe differs from the exact source, command, selection or runtime.',
    );
    const tests = recipe.groups.flat();
    invariant(
      standard
        ? new Set(tests).size === tests.length &&
            checkPin([...tests].sort()) === checkPin([...recipe.selection.tests].sort())
        : recipe.groups.length === 0,
      'EVIDENCE_CHANGED',
      'Actions shard membership differs from the selected tests.',
    );
    const generated = new Map([
      ['.github/workflows/forge-check.yml', githubActionsWorkflow(input.configuration.runsOn)],
      ['.github/forge-check-plan.json', JSON.stringify(recipe)],
    ]);
    const semanticCommand = semanticCheckCommand(
      ['node', 'scripts/forge-check.mjs'],
      input.semanticPlan,
      'node',
      tests,
    );
    if (semanticCommand.length > 2) {
      const occupied = new Set(
        state.files.filter(file => file.path.startsWith('.github/')).map(file => file.path.split('/')[1]),
      );
      const name = `forge-semantic-static-${input.id}`;
      let suffix = 0,
        file = `${name}.mjs`;
      while (occupied.has(file)) file = `${name}-${++suffix}.mjs`;
      const script = `.github/${file}`;
      const workflow = generated.get('.github/workflows/forge-check.yml')!;
      // Existing shards own their selected files; the static job covers only
      // missing contract files after its configured preparation. No new job/run.
      const marker = '      - run: node scripts/forge-check.mjs';
      const position = workflow.lastIndexOf(marker);
      generated.set(
        '.github/workflows/forge-check.yml',
        workflow.slice(0, position) + workflow.slice(position).replace(marker, `      - run: node ${script}`),
      );
      generated.set(
        script,
        `import {spawn} from 'node:child_process';const command=${JSON.stringify(semanticCommand)};const child=spawn(command[0],command.slice(1),{stdio:'inherit'});child.on('error',()=>{process.exitCode=1});child.on('close',code=>{process.exitCode=code??1});`,
      );
    }
    // A generated harness may replace those exact files, as in the local exporter.
    // A file/symlink at an ancestor would make that export unrepresentable.
    invariant(
      !state.files.some(
        f =>
          ['.github', '.github/workflows'].includes(f.path) ||
          [...generated.keys()].some(path => f.path.startsWith(path + '/')),
      ),
      'EVIDENCE_CHANGED',
      'The generated Actions harness overlaps a source directory or file.',
    );
    await hostedActionsGit(root, ['init', '--bare', '--template=', '--initial-branch=forge-export']);
    const entries: string[] = [];
    let lockfile = digest('');
    // Deduplicate before describing; consume grants and stream bytes in bounded windows.
    await reader.resolveMany(state.files.map(file => file.blob));
    for (const file of state.files) {
      const path = join(cache, file.blob);
      if (file.path === 'package-lock.json') lockfile = file.blob;
      if (generated.has(file.path)) continue;
      const hash = await hostedActionsGit(root, ['hash-object', '--no-filters', '-w', path]);
      const mode = file.mode === 'symlink' ? '120000' : file.mode === 'executable' ? '100755' : '100644';
      entries.push(`${mode} ${hash}\t${file.path}\0`);
      await progress();
    }
    // The local contract hashes the exact lockfile bytes, or the empty string.
    invariant(
      lockfile === input.plan.lockfile,
      'EVIDENCE_CHANGED',
      'Actions lockfile differs from the prepared plan.',
    );
    for (const [path, text] of generated) {
      const hash = await hostedActionsGit(root, ['hash-object', '--no-filters', '-w', '--stdin'], text);
      entries.push(`100644 ${hash}\t${path}\0`);
    }
    await hostedActionsGit(root, ['read-tree', '--empty']);
    await hostedActionsGit(root, ['update-index', '-z', '--index-info'], entries.join(''));
    const tree = await hostedActionsGit(root, ['write-tree']);
    const commit = await hostedActionsGit(
      root,
      ['commit-tree', tree],
      `Forge check ${input.id}\nState ${input.request.expectedHead}\nPlan ${input.planDigest}\n`,
    );
    const ref = `refs/heads/forge-check/${input.id}`;
    await hostedActionsGit(root, ['update-ref', ref, commit]);
    const bundlePath = join(root, 'export.bundle');
    await hostedActionsGit(root, ['bundle', 'create', bundlePath, ref]);
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(bundlePath)) {
      hash.update(bytes);
      await progress();
    }
    const bundle = { sha256: hash.digest('hex'), size: (await stat(bundlePath)).size };
    await transport.upload(bundle, createReadStream(bundlePath));
    return {
      export: { commit, bundle },
      metrics: {
        ...reader.metrics,
        bundleBytes: bundle.size,
        sourceFiles: state.files.length,
        rssBytes: process.memoryUsage().rss,
      },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Reuse retained bundle bytes on reconnect; never rebuild an already mapped export. */
export async function withHostedActionsExport<T>(
  exported: ActionsExport,
  transport: SourceWorkerTransport,
  use: (root: string) => Promise<T>,
) {
  const root = await mkdtemp(join(tmpdir(), 'forge-actions-publish-'));
  try {
    const reader = new SourceWorkerReader(root, transport);
    const bundle = await reader.file({ object: exported.bundle, recipe: null });
    await hostedActionsGit(root, ['init', '--bare', '--template=']);
    await hostedActionsGit(root, ['fetch', '--no-tags', bundle, exported.commit]);
    invariant(
      (await hostedActionsGit(root, ['rev-parse', 'FETCH_HEAD'])) === exported.commit,
      'EVIDENCE_CHANGED',
      'Retained Actions bundle names different source.',
    );
    return await use(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
