// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { nativeManifestSchema } from './work-archive-metadata.js';
import { parseWorkBytes } from './work-metadata.js';
import { overlayHostedJournal } from './work-backup.js';
import { nativeReachable } from './native-reachable.js';
import type { WorkStore } from './work-store.js';
import type { CompanionCommand } from './native-companion-types.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { readSource } from './files.js';
// An already-present source owner can receive hosted metadata directly from the
// immutable manifest. Evidence files are not imported or used to grant authority.
export function validateExchangeCompanion(
  store: WorkStore,
  command: CompanionCommand,
  scratch: string,
  journalPath: string,
) {
  const directory = realpathSync(command.archivePath),
    manifestBytes = readFileSync(join(directory, 'manifest.json'));
  invariant(
    digest(manifestBytes) === (command.manifestSha256 ?? command.archiveSha256),
    'INVALID_WORK_BACKUP',
    'Original exchange manifest differs from its selected digest.',
  );
  const manifest = nativeManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8'))),
    pin = manifest.files.find(file => file.path === 'work.json');
  invariant(pin, 'INVALID_WORK_BACKUP', 'Exchange manifest omits its original Work.');
  const bytes = readSource(directory, 'work.json', pin.size + 1, pin.sha256);
  invariant(
    bytes && bytes.length === pin.size && digest(bytes) === pin.sha256,
    'INVALID_WORK_BACKUP',
    'Original Work differs from the exchange manifest.',
  );
  const base = parseWorkBytes(bytes);
  invariant(
    base.nativeHead === manifest.head && base.revision === manifest.revision,
    'INVALID_WORK_BACKUP',
    'Original source and Work pins differ.',
  );
  const listed = new Set(
    manifest.files.filter(file => file.path === `objects/${file.sha256}`).map(file => file.sha256),
  );
  invariant(
    nativeReachable(store, base).every(id => listed.has(id)),
    'INVALID_WORK_BACKUP',
    'The exchange source closure is incomplete in this owner or manifest.',
  );
  const replay = join(scratch, 'exchange');
  mkdirSync(replay, { mode: 0o700 });
  writeFileSync(join(replay, 'manifest.json'), manifestBytes, { mode: 0o600 });
  writeFileSync(join(replay, 'work.json'), bytes, { mode: 0o600 });
  overlayHostedJournal(replay, command.archiveSha256, journalPath);
  return { base, hosted: parseWorkBytes(readFileSync(join(replay, 'work.json'))) };
}
