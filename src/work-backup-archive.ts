// SPDX-License-Identifier: Apache-2.0
import { childEnv } from '../scripts/child-env.mjs';
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureArtifacts } from './work-artifacts.js';
import { fingerprintPrivateFile } from './files.js';
import { ForgeError, invariant } from './errors.js';
import { artifactArchivePlan, materializeArtifactAliases } from './native-artifact-alias.js';

const code = 'INVALID_WORK_BACKUP';
const env = () => childEnv({ extra: { LC_ALL: 'C' } });
function tar(args: string[], cwd: string, input?: Buffer): Buffer {
  const scratch = mkdtempSync(join(tmpdir(), 'forge-tar-')),
    output = join(scratch, 'stdout');
  let fd: number | undefined;
  try {
    fd = openSync(output, 'wx', 0o600);
    // Owner-sized manifests/listings can also exceed execFile's pipe buffer.
    // Spool native stdout privately, then read the complete metadata as before.
    execFileSync('tar', args, {
      cwd,
      env: env(),
      maxBuffer: 4 * 1024 * 1024,
      input,
      stdio: [input ? 'pipe' : 'ignore', fd, 'pipe'],
    });
    return readFileSync(output);
  } catch {
    throw new ForgeError(
      code,
      'Native tar could not process this backup. Original source and Work are preserved.',
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(scratch, { recursive: true, force: true });
  }
}
export async function packWorkArchive(directory: string, files: string[]) {
  const path = `${directory}.tar.gz`;
  // Keep argv constant at owner scale. NUL-delimited names are literal on both
  // BSD and GNU tar; no shell or file-list option interpretation is involved.
  tar(
    ['--format=ustar', '-czf', path, '--null', '-T', '-'],
    directory,
    Buffer.from(['manifest.json', ...files, ''].join('\0')),
  );
  chmodSync(path, 0o600);
  invariant(
    tar(['-tzf', path], directory).toString().trim().split('\n').sort().join('\n') ===
      ['manifest.json', ...files].sort().join('\n'),
    code,
    'Archive file coverage differs from the directory manifest.',
  );
  invariant(
    tar(['-xzOf', path, '--', 'manifest.json'], directory).equals(
      readFileSync(join(directory, 'manifest.json')),
    ),
    code,
    'Archive manifest differs from the original.',
  );
  return { path, ...(await fingerprintPrivateFile(path, code)) };
}

export async function withWorkArchive<T>(
  input: string,
  use: (directory: string, archive: { sha256: string; size: number }) => Promise<T>,
): Promise<T> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'forge-backup-')));
  chmodSync(scratch, 0o700);
  try {
    const [captured] = await captureArtifacts(realpathSync(dirname(input)), scratch, [basename(input)]);
    invariant(captured?.status === 'retained', code, 'The selected archive could not be copied safely.');
    const archive = join(scratch, 'artifacts', captured.filename),
      directory = join(scratch, 'directory');
    mkdirSync(directory, { mode: 0o700 });
    const manifest = tar(['-xzOf', archive, '--', 'manifest.json'], scratch);
    let files: { path: string; size: number; sha256?: string }[], metadata;
    try {
      metadata = JSON.parse(manifest.toString());
      files = metadata.files;
    } catch {
      throw new ForgeError(code, 'Archive manifest is invalid.');
    }
    const allowed =
      /^(?:manifest\.json|work\.json|objects\/[0-9a-f]{64}|source\.bundle|(?:discussion|contribution)-[0-9a-f-]{36}\.(?:json|bundle)|check-[0-9a-f-]{36}\/(?:stdout\.log|stderr\.log|result\.json|test-reports\.json|modal-plan\.json|modal-shard-logs\.json|changes\.json|resources\.txt|artifacts\/artifact-[0-9]+\.bin))$/i;
    invariant(
      Array.isArray(files) &&
        files.every(
          file =>
            file &&
            typeof file.path === 'string' &&
            allowed.test(file.path) &&
            file.path !== 'manifest.json' &&
            Number.isSafeInteger(file.size) &&
            file.size >= 0,
        ),
      code,
      'Archive file paths or sizes are invalid.',
    );
    const plan = artifactArchivePlan(metadata);
    const names = ['manifest.json', ...plan.physical.map(file => file.path)];
    invariant(
      new Set(names).size === names.length &&
        tar(['-tzf', archive], scratch).toString().trim().split('\n').sort().join('\n') ===
          names.sort().join('\n'),
      code,
      'Archive includes missing, duplicate or unexpected files.',
    );
    const listing = tar(['-tvzf', archive], scratch).toString();
    invariant(
      listing
        .trim()
        .split('\n')
        .every(line => line.startsWith('-')),
      code,
      'Archive entries must be ordinary files.',
    );
    const entries = [{ path: 'manifest.json', size: manifest.length }, ...plan.physical];
    validateArchiveEntrySizes(listing, entries);
    // Preserve exclusive destination creation, including case-alias collisions on the current filesystem.
    for (const file of entries) {
      const destination = join(directory, file.path);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      writeFileSync(destination, Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
    }
    // All names, types and declared sizes are validated before one native extraction pass.
    const child = spawn(
      'tar',
      ['-xzf', archive, '-C', directory, '--no-same-owner', '--no-same-permissions'],
      { cwd: scratch, env: env(), stdio: 'ignore' },
    );
    const exit = await new Promise<number | null>(resolve => {
      child.once('error', () => resolve(null));
      child.once('close', resolve);
    });
    invariant(
      exit === 0,
      code,
      'Native tar could not extract this backup. Original source and Work are preserved.',
    );
    for (const file of entries) {
      const destination = join(directory, file.path),
        stat = lstatSync(destination);
      invariant(
        stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === file.size,
        code,
        'Archive entry is incomplete or differs from its recorded size.',
      );
      chmodSync(destination, 0o600);
      for (let parent = dirname(destination); parent !== directory; parent = dirname(parent))
        chmodSync(parent, 0o700);
      if ('sha256' in file)
        invariant(
          (await fingerprintPrivateFile(destination, code)).sha256 === file.sha256,
          code,
          'Archive entry bytes differ from the original manifest.',
        );
    }
    invariant(
      readFileSync(join(directory, 'manifest.json')).equals(manifest),
      code,
      'Extracted archive manifest differs from the original.',
    );
    await materializeArtifactAliases(directory, files, plan.aliases);
    return await use(directory, { sha256: captured.sha256, size: captured.size });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// GNU and BSD tar's C-locale verbose listings put the entry size immediately before the date.
// Allowed paths contain no whitespace, and exact entry coverage was checked independently.
export function validateArchiveEntrySizes(listing: string, files: { path: string; size: number }[]) {
  const sizes = new Map(files.map(file => [file.path, file.size]));
  const lines = listing.trim().split('\n');
  invariant(lines.length === files.length, code, 'Archive entry sizes differ from its manifest.');
  for (const line of lines) {
    const match =
      /^-\S*\s+.+?\s+(\d+)\s+(?:\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?|[A-Z][a-z]{2}\s+\d{1,2}\s+(?:\d{2}:\d{2}(?::\d{2})?|\d{4}))\s+(.+)$/.exec(
        line,
      );
    invariant(
      match && Number.isSafeInteger(Number(match[1])) && sizes.get(match[2]!) === Number(match[1]),
      code,
      'Archive entry size differs from its recorded size.',
    );
    sizes.delete(match[2]!);
  }
  invariant(sizes.size === 0, code, 'Archive entry sizes differ from its manifest.');
}
