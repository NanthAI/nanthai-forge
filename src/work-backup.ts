import { portableCheckPath, runLogRecord, checkLogCoverage } from './check-log-policy.js';
// SPDX-License-Identifier: Apache-2.0
import { retainRecoveryCapture } from './recovery-capture.js';
import { migrateHostedIntents } from './work-hosted-intents.js';
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest } from './hash.js';
import { fingerprintPrivateFile, readSource, safeRelative } from './files.js';
import { invariant } from './errors.js';
import { WorkStore } from './work-store.js';
import { branchFor, executionGuard, headAt, workGit } from './work-git.js';
import { recoverRuns } from './work-run.js';
import { fullGitBundle } from './work-git-bundle.js';
import { withGithubTransport } from './work-github.js';
import { packWorkArchive, withWorkArchive } from './work-backup-archive.js';
import {
  applyHostedEvent,
  hostedJournalSchema,
  parseWorkBytes,
  workBytes,
  validateMetadataSource,
  validateHostedChannel,
  validateWorkSize,
} from './work-metadata.js';
import {
  manifestSchema,
  fileSchema,
  sourceManifestSchema,
  archiveSource,
  workSourcePins,
} from './work-archive-metadata.js';
import { type WorkData } from './work-types.js';

const code = 'INVALID_WORK_BACKUP';
const coverage =
  'Full original committed source/history, retained Git refs, Work records and listed private evidence files. Uncommitted/index changes, workspaces, ignored files, Git configuration/credentials, graphs and hosted identity/storage/grants are excluded. Logs and tracked history can contain private data. Restore never starts recorded commands; unfinished runs become interrupted. Hashes detect changed bytes, not authenticated authorship.';

function ownedFiles(data: WorkData) {
  return [
    'work.json',
    ...data.githubDiscussions.map(item => `discussion-${item.id}.json`),
    ...data.lanes.filter(item => item.contribution).map(item => `contribution-${item.id}.bundle`),
    ...data.runs.flatMap(run => [
      ...[
        'stdout.log',
        'stderr.log',
        'result.json',
        'test-reports.json',
        'modal-plan.json',
        'modal-shard-logs.json',
        'changes.json',
        ...(run.check.measureResources ? ['resources.txt'] : []),
      ].map(name => `check-${run.id}/${name}`),
      ...(run.artifacts ?? [])
        .filter(item => item.status === 'retained')
        .map(item => `check-${run.id}/artifacts/${item.filename}`),
    ]),
  ];
}
function refsAt(store: WorkStore) {
  return workGit(store.root, ['for-each-ref', '--format=%(refname) %(objectname)'])
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [ref, head] = line.split(' ');
      return { ref: ref!, head: head! };
    });
}
function containedFile(root: string, path: string) {
  invariant(safeRelative(path), code, 'Backup file paths must be contained.');
  let current = root;
  for (const part of path.split('/')) {
    current = join(current, part);
    invariant(!lstatSync(current).isSymbolicLink(), code, 'Backup symlinks are not followed.');
  }
  invariant(realpathSync(current) === current, code, 'Backup path changed.');
  return current;
}
export async function copyPrivate(source: string, destination: string) {
  const before = await fingerprintPrivateFile(source, code);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(source, destination, constants.COPYFILE_EXCL);
  chmodSync(destination, 0o600);
  const copied = await fingerprintPrivateFile(destination, code),
    after = await fingerprintPrivateFile(source, code);
  invariant(
    before.sha256 === copied.sha256 &&
      before.sha256 === after.sha256 &&
      before.size === copied.size &&
      before.size === after.size,
    code,
    'Evidence changed while being copied. Retry with its current observation.',
  );
  return copied;
}

export async function exportWork(store: WorkStore, revision: number, archive = false) {
  invariant(Number.isSafeInteger(revision) && revision >= 0, 'BAD_ARGUMENT', 'Send a valid Work revision.');
  const snapshot = store.locked(() => {
    const data = store.load(),
      refs = refsAt(store),
      head = headAt(store.root);
    const bytes = store.snapshotBytes();
    return { data, refs, head, bytes, capturedAt: new Date().toISOString() };
  });
  const id = randomUUID(),
    path = mkdtempSync(join(store.directory, 'backup-'));
  chmodSync(path, 0o700);
  try {
    const files: z.infer<typeof fileSchema>[] = [],
      unavailable: string[] = [];
    writeFileSync(join(path, 'work.json'), snapshot.bytes, { mode: 0o600, flag: 'wx' });
    files.push({ path: 'work.json', ...(await fingerprintPrivateFile(join(path, 'work.json'), code)) });
    for (const name of ownedFiles(snapshot.data).filter(
      name => name !== 'work.json' && portableCheckPath(snapshot.data, name),
    )) {
      if (!existsSync(join(store.directory, name))) {
        if (!/(?:test-reports|modal-plan|modal-shard-logs|changes)\.json$/.test(name)) unavailable.push(name);
        continue;
      }
      files.push({
        path: name,
        ...(await copyPrivate(containedFile(store.directory, name), join(path, name))),
      });
    }
    const pins = workSourcePins(snapshot.data);
    if (pins.length) {
      const observed = workGit(
        store.root,
        ['--no-lazy-fetch', 'cat-file', '--batch-check=%(objectname) %(objecttype)'],
        pins.join('\n') + '\n',
      )
        .trim()
        .split('\n');
      invariant(
        observed.every((line, i) => line === `${pins[i]} commit`),
        code,
        'A retained local source pin is missing. Existing work is preserved.',
      );
    }
    const refs = [
      ...snapshot.refs,
      { ref: `refs/forge/backup/${id}/checkout`, head: snapshot.head },
      ...pins.map(head => ({ ref: `refs/forge/backup/${id}/pins/${head}`, head })),
    ];
    const bundle = await withGithubTransport(store, transport =>
      fullGitBundle(transport, refs, join(path, 'source.bundle'), code),
    );
    files.push({ path: 'source.bundle', ...bundle });
    store.locked(() => {
      invariant(
        JSON.stringify(store.load()) === JSON.stringify(snapshot.data) &&
          headAt(store.root) === snapshot.head &&
          JSON.stringify(refsAt(store)) === JSON.stringify(snapshot.refs),
        'WORK_STALE',
        'Source or Work changed during export. Retry its current snapshot; nothing was overwritten.',
      );
    });
    writeFileSync(
      join(path, 'recovery-timing.json'),
      JSON.stringify({ capturedAt: snapshot.capturedAt, evidenceCapturedAt: new Date().toISOString() }),
      { flag: 'wx', mode: 0o600 },
    );
    const manifest = {
      schema: 1 as const,
      kind: 'forge-source-and-work' as const,
      id,
      at: new Date().toISOString(),
      head: snapshot.head,
      format: workGit(store.root, ['rev-parse', '--show-object-format']).trim(),
      revision: snapshot.data.revision,
      refs,
      files,
      unavailable,
      coverage: `${coverage} ${checkLogCoverage}`,
      checkLogs: snapshot.data.runs.map(run => runLogRecord(snapshot.data, run)),
    };
    const json = JSON.stringify(manifest, null, 2) + '\n';
    writeFileSync(join(path, 'manifest.json'), json, { mode: 0o600, flag: 'wx' });
    const packed = archive
      ? await packWorkArchive(
          path,
          files.map(file => file.path),
        )
      : undefined;
    return {
      revision: snapshot.data.revision,
      result: {
        recovery: retainRecoveryCapture(
          store,
          path,
          { sha256: digest(json), size: Buffer.byteLength(json) },
          { kind: 'export' },
        ),
        id,
        path,
        sha256: digest(json),
        head: snapshot.head,
        files: files.length,
        unavailable,
        coverage,
        ...(packed ? { archive: packed } : {}),
      },
    };
  } catch (error) {
    rmSync(path, { recursive: true, force: true });
    rmSync(`${path}.tar.gz`, { force: true });
    throw error;
  }
}

export async function restoreWork(input: string, destination: string, journalPath?: string) {
  if (lstatSync(input).isFile())
    return withWorkArchive(input, async (directory, archive) => {
      if (journalPath) overlayHostedJournal(directory, archive.sha256, journalPath);
      return restoreDirectory(directory, destination);
    });
  invariant(!journalPath, 'BAD_ARGUMENT', 'Restore a hosted journal with its original archive file.');
  return restoreDirectory(input, destination);
}
export function overlayHostedJournal(directory: string, archiveSha256: string, input: string) {
  const bytes = readSource(realpathSync(dirname(input)), basename(input), Number.MAX_SAFE_INTEGER);
  invariant(
    bytes,
    'INVALID_WORK_JOURNAL',
    'Hosted journal is unavailable or exceeds the existing Work format.',
  );
  let journal: z.infer<typeof hostedJournalSchema>;
  try {
    journal = hostedJournalSchema.parse(JSON.parse(bytes.toString('utf8')));
  } catch {
    invariant(false, 'INVALID_WORK_JOURNAL', 'Hosted Work journal is invalid.');
  }
  const manifestBytes = readFileSync(join(directory, 'manifest.json')),
    manifest = sourceManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
  const original = readFileSync(join(directory, 'work.json'));
  invariant(
    journal.base.archiveSha256 === archiveSha256 &&
      journal.base.manifestSha256 === digest(manifestBytes) &&
      journal.base.workSha256 === digest(original),
    'INVALID_WORK_JOURNAL',
    'Select this journal’s exact original source/Work archive. Existing source is preserved.',
  );
  let data = parseWorkBytes(original);
  // Journal commands never introduce a new source pin: even a new Intent must
  // select a base already retained here. Keep the first lookup at the original
  // validation point so malformed dependency pins still fail before replay.
  let source: ReturnType<typeof archiveSource> | undefined;
  const retained = () => (source ??= archiveSource(manifest, data));
  for (const event of journal.events) {
    data = migrateHostedIntents(data, journal.intentMigration);
    invariant(
      event.projectKey === journal.projectKey && event.archiveSha256 === archiveSha256,
      'INVALID_WORK_JOURNAL',
      'Operation provenance differs from the original hosted project.',
    );
    if (event.command.action === 'accept-hosted-channel')
      validateHostedChannel(data, event.command, retained());
    else if (event.command.action !== 'source-return')
      validateMetadataSource(data, event.command, retained());
    applyHostedEvent(data, event);
  }
  data = migrateHostedIntents(data, journal.intentMigration);
  validateWorkSize(data);
  const next = workBytes(data);
  invariant(
    data.revision === journal.revision && digest(next) === journal.workSha256,
    'INVALID_WORK_JOURNAL',
    'Hosted Work bytes differ from the original operation sequence.',
  );
  const workFile = manifest.files.find(file => file.path === 'work.json');
  invariant(workFile, code, 'The original Work file is not in the source manifest.');
  workFile.sha256 = digest(next);
  workFile.size = Buffer.byteLength(next);
  manifest.revision = data.revision;
  // Only private captured metadata changes. Original source bundle, evidence files and selected archive remain byte-identical.
  writeFileSync(join(directory, 'work.json'), next, { mode: 0o600 });
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
}
async function restoreDirectory(input: string, destination: string) {
  const backup = realpathSync(input),
    requested = resolve(destination),
    parent = realpathSync(dirname(requested)),
    target = join(parent, basename(requested));
  invariant(
    !lstatSync(backup).isSymbolicLink() && lstatSync(backup).isDirectory(),
    code,
    'Select a real backup directory.',
  );
  const manifestPath = containedFile(backup, 'manifest.json');
  const observed = await fingerprintPrivateFile(manifestPath, code);
  let manifest: z.infer<typeof manifestSchema>;
  try {
    manifest = manifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
  } catch {
    invariant(false, code, 'Backup manifest is invalid.');
  }
  invariant(digest(readFileSync(manifestPath)) === observed.sha256, code, 'Backup manifest changed.');
  invariant(
    manifest.head.length === (manifest.format === 'sha1' ? 40 : 64) &&
      manifest.refs.every(item => item.head.length === manifest.head.length),
    code,
    'Source object format differs from its pins.',
  );
  if (existsSync(target)) {
    let matches = false;
    try {
      if (!lstatSync(target).isSymbolicLink()) {
        const receipt = readSource(target, '.git/forge-work/restore.json', 4 * 1024 * 1024);
        matches = !!receipt && JSON.parse(receipt.toString()).sha256 === observed.sha256;
      }
    } catch {
      /* An existing ambiguous destination is never replaced. */
    }
    invariant(
      matches,
      'RESTORE_TARGET_EXISTS',
      'Restore uses a new directory. Existing work is never overwritten.',
    );
    materializeRestoredLanes(target);
    return {
      root: target,
      head: manifest.head,
      sha256: observed.sha256,
      restored: true,
      original: true,
      unavailable: manifest.unavailable,
      coverage: manifest.coverage,
    };
  }
  const scratch = mkdtempSync(join(parent, '.forge-restore-'));
  chmodSync(scratch, 0o700);
  try {
    const bytes = readSource(backup, 'work.json', Number.MAX_SAFE_INTEGER);
    invariant(bytes, code, 'Work records are unavailable.');
    invariant(
      digest(bytes) === manifest.files.find(file => file.path === 'work.json')?.sha256,
      code,
      'Work bytes differ from the manifest.',
    );
    let data: WorkData;
    try {
      data = parseWorkBytes(bytes);
    } catch {
      invariant(false, code, 'Backup Work records are invalid.');
    }
    invariant(data.revision === manifest.revision, code, 'Work revision differs from the manifest.');
    const allowed = new Set([...ownedFiles(data), 'source.bundle']),
      names = new Set<string>();
    workGit(scratch, [
      'init',
      '--template=',
      `--object-format=${manifest.format}`,
      '--initial-branch=forge-restored',
    ]);
    const store = new WorkStore(scratch);
    for (const file of manifest.files) {
      invariant(
        allowed.has(file.path) && !names.has(file.path),
        code,
        'Backup includes an unknown or duplicate file.',
      );
      if (!portableCheckPath(data, file.path) && !existsSync(join(backup, file.path))) continue;
      names.add(file.path);
      const copied = await copyPrivate(containedFile(backup, file.path), join(store.directory, file.path));
      invariant(
        copied.sha256 === file.sha256 && copied.size === file.size,
        code,
        'Backup file differs from its recorded digest.',
      );
    }
    invariant(
      names.has('work.json') &&
        names.has('source.bundle') &&
        manifest.unavailable.every(name => allowed.has(name) && !names.has(name)) &&
        [...allowed].every(
          name =>
            names.has(name) ||
            manifest.unavailable.includes(name) ||
            /(?:test-reports|modal-plan|modal-shard-logs|changes)\.json$/.test(name) ||
            !portableCheckPath(data, name),
        ),
      code,
      'Backup file coverage is incomplete.',
    );
    const bundle = join(store.directory, 'source.bundle');
    workGit(scratch, ['--no-lazy-fetch', 'bundle', 'verify', bundle]);
    invariant(
      workGit(scratch, ['bundle', 'list-heads', bundle]).trim().split('\n').sort().join('\n') ===
        manifest.refs
          .map(item => `${item.head} ${item.ref}`)
          .sort()
          .join('\n'),
      code,
      'Bundle refs differ from the manifest.',
    );
    workGit(scratch, ['bundle', 'unbundle', bundle]);
    for (const item of manifest.refs) workGit(scratch, ['check-ref-format', item.ref]);
    invariant(
      new Set(manifest.refs.map(item => item.ref)).size === manifest.refs.length,
      code,
      'Backup refs are duplicated.',
    );
    workGit(
      scratch,
      ['update-ref', '--stdin'],
      'start\n' +
        manifest.refs.map(item => `create ${item.ref} ${item.head}\n`).join('') +
        'prepare\ncommit\n',
    );
    workGit(scratch, ['--no-lazy-fetch', 'fsck', '--connectivity-only', '--no-reflogs']);
    workGit(scratch, ['checkout', '--detach', manifest.head]);
    const endedAt = new Date().toISOString();
    let changed = recoverRuns(store, data);
    for (const run of [...data.runs, ...data.playbookRuns]) {
      if (!['queued', 'preparing', 'running'].includes(run.status)) continue;
      run.status = 'interrupted';
      run.endedAt = endedAt;
      run.details += ' Restored snapshot: original processes are not attached or restarted.';
      changed = true;
    }
    if (changed) {
      data.revision++;
      store.save(data);
    }
    writeFileSync(
      join(store.directory, 'restore.json'),
      JSON.stringify({
        id: manifest.id,
        sha256: observed.sha256,
        at: endedAt,
        originalRevision: manifest.revision,
        revision: data.revision,
        interrupted: changed,
        unavailable: manifest.unavailable,
      }),
      { mode: 0o600, flag: 'wx' },
    );
    try {
      mkdirSync(target, { mode: 0o700 });
    } catch {
      invariant(false, 'RESTORE_TARGET_EXISTS', 'Restore destination appeared; existing work is preserved.');
    }
    try {
      renameSync(scratch, target);
    } catch (error) {
      try {
        rmdirSync(target);
      } catch {
        /* Preserve any concurrently added files. */
      }
      throw error;
    }
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
  // Materialize only after the final path exists: native worktree links contain absolute paths.
  materializeRestoredLanes(target);
  return {
    root: target,
    head: manifest.head,
    sha256: observed.sha256,
    restored: true,
    original: false,
    unavailable: manifest.unavailable,
    coverage: manifest.coverage,
  };
}
function materializeRestoredLanes(target: string) {
  const restored = new WorkStore(target);
  executionGuard(target);
  for (const lane of restored.load().lanes) {
    const branch = branchFor(lane.id);
    if (!existsSync(restored.path(lane.id))) {
      const retained = workGit(target, ['show-ref', '--verify', '--hash', branch], undefined, true).trim();
      if (!retained) workGit(target, ['update-ref', branch, lane.head]);
      workGit(target, ['worktree', 'add', restored.path(lane.id), branch.slice('refs/heads/'.length)]);
    }
  }
}
