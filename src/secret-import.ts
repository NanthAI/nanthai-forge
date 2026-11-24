// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// `nforge secret import` (Item 41a0df87 slice 3, owner decision 4): a .env file's values go into the Development set,
// its names into the root .env.example, and the plaintext file is removed unless kept, with the undo printed. An
// agent's import adds new names and proposes changes to names that exist or existed. `--restore` writes the file
// back from Development for a person on a terminal. Output names variables and counts, never a value.
import { join, relative, resolve } from 'node:path';
import { ForgeError, invariant } from './errors.js';
import type { SealedClient } from './sealed-client.js';
import { safeSecretName } from './sealed-display.js';
import { readSecretExample } from './secret-env-example.js';
import { secretNameRefusal } from './secret-names.js';
import { checkProposalRoom } from './sealed-proposal-client.js';
import { settleImportWrites } from './sealed-resolve.js';
import {
  addExampleNames,
  dotenvLine,
  parseDotenvBytes,
  readDotenvFile,
  removeIfUnchanged,
  writeNewPrivate,
} from './secret-dotenv.js';

/** Names per head write: the server's work cap is 100 units, 1 per changed record and 2 per added roster entry (a
 * genesis adds one), so 90 leaves room in every write. */
const IMPORT_BATCH = 90;
const list = (names: readonly string[]) =>
  names.length > 6
    ? `${names.slice(0, 6).map(safeSecretName).join(', ')} and ${names.length - 6} more`
    : names.map(safeSecretName).join(', ');

export async function importDotenv(
  client: SealedClient,
  root: string,
  file: string | undefined,
  options: { keep: boolean; cwd: string },
) {
  const path = file ? resolve(options.cwd, file) : join(root, '.env');
  const shown = relative(options.cwd, path) || path;
  // Refuses an unusable .env.example (a link, a case variant) before anything is written.
  addExampleNames(root, []);
  const read = readDotenvFile(path);
  let parsed: ReturnType<typeof parseDotenvBytes>;
  try {
    parsed = parseDotenvBytes(read.bytes);
  } finally {
    read.bytes.fill(0);
  }
  const skipped = parsed.notices.map(n => `${n.name} (${n.reason})`);
  const entries = parsed.entries.filter(entry => {
    const refusal = secretNameRefusal(entry.name, client.agent);
    if (!refusal) return true;
    // Review L1: an invalid name is text from a malformed line, so only its line number is shown.
    skipped.push(
      refusal === 'invalid name'
        ? `line ${entry.line} (invalid name)`
        : `${safeSecretName(entry.name)} (${refusal === 'PERSON_REQUIRED' ? 'a person imports a routing name' : refusal})`,
    );
    entry.value.fill(0);
    return false;
  });
  const written: string[] = [],
    unchanged: string[] = [],
    proposed: string[] = [];
  try {
    // Review L5: an agent import over several writes checks room for all its proposals before the first one.
    if (client.agent && entries.length > IMPORT_BATCH) {
      const state = await client.read();
      try {
        if (state)
          await checkProposalRoom(
            client,
            state,
            entries.filter(e => state.pin.head.names.some(n => n.name === e.name)).map(e => e.name),
          );
      } finally {
        state?.key?.fill(0);
        for (const secret of state?.secrets ?? []) secret.value.fill(0);
      }
    }
    for (let i = 0; i < entries.length; i += IMPORT_BATCH) {
      const done = await client
        .writeMany(
          entries.slice(i, i + IMPORT_BATCH).map(e => ({ name: e.name, value: e.value })),
          { skipUnchanged: true },
        )
        .catch(error => {
          const id =
            error instanceof ForgeError &&
            error.code === 'SECRETS_WRITE_UNKNOWN' &&
            error.recovery?.operationId;
          throw typeof id === 'string'
            ? new ForgeError(
                error.code,
                `The outcome of import write ${id} is unknown; ${written.length} names were imported before it. Run nforge secret import again: it confirms or clears that write and imports what is missing. To settle that write alone: nforge secret resolve --operation-id ${id}.`,
                undefined,
                error.recovery,
              )
            : error;
        });
      written.push(...done.written);
      unchanged.push(...done.unchanged);
      proposed.push(...done.proposed.map(p => p.name));
    }
  } finally {
    for (const entry of entries) entry.value.fill(0);
  }
  // Review L4: an earlier import's write with an unknown outcome is confirmed or cleared now, not left to fill the
  // journal.
  const settled = await settleImportWrites(
    client,
    new Set(entries.map(e => e.name)),
    new Set([...written, ...unchanged]),
  );
  const lines: string[] = [];
  if (written.length) lines.push(`Imported into Development: ${list(written)}.`);
  if (unchanged.length) lines.push(`Already in Development, unchanged: ${list(unchanged)}.`);
  if (proposed.length)
    lines.push(
      `Proposed for a person, since they exist or existed in Development: ${list(proposed)} (nforge secret proposals).`,
    );
  if (skipped.length)
    lines.push(
      `Not imported: ${skipped.slice(0, 6).join(', ')}${skipped.length > 6 ? ` and ${skipped.length - 6} more` : ''}.`,
    );
  if (settled)
    lines.push(
      `Settled ${settled} earlier import write${settled === 1 ? '' : 's'} whose outcome was unknown.`,
    );
  const added = addExampleNames(root, [...written, ...unchanged, ...proposed]);
  if (added.length) lines.push(`.env.example now lists ${list(added)} (names only).`);
  const removed =
    options.keep || skipped.length || proposed.length ? undefined : removeIfUnchanged(path, read);
  const kept = options.keep
    ? 'you asked to keep it'
    : skipped.length
      ? 'some lines were not imported'
      : proposed.length
        ? 'proposals wait for a person'
        : removed === 'changed'
          ? 'it changed during the import'
          : typeof removed === 'object'
            ? `it changed during the import and another file took its place, so it is at ${relative(options.cwd, removed.aside) || removed.aside}`
            : undefined;
  lines.push(
    kept
      ? `Kept ${shown}: ${kept}.`
      : `Removed ${shown}; its values are in Development. Run programs with nforge run -- COMMAND. Undo: nforge secret import --restore${file ? ` ${shown}` : ''} (a person, on a terminal).`,
  );
  return lines;
}

/** Writes the Development env values that .env.example lists into a new private file, in the example's order. */
export async function restoreDotenv(
  client: SealedClient,
  root: string,
  file: string | undefined,
  cwd: string,
) {
  invariant(
    !client.agent,
    'PERSON_REQUIRED',
    'A person writes values to a file: run nforge secret import --restore on a terminal.',
  );
  const path = file ? resolve(cwd, file) : join(root, '.env');
  const names = readSecretExample(root).names;
  const state = await client.read();
  invariant(state, 'SECRETS_NOT_SET_UP', 'Development is not set up. The owner runs nforge secret set NAME.');
  const lines: string[] = [],
    left: string[] = [];
  try {
    for (const name of names) {
      const record = state.pin.head.names.find(n => n.name === name);
      const secret = state.secrets.find(s => s.name === name);
      if (!record || record.kind !== 1 || !secret) continue;
      const value = secret.value.toString('utf8');
      const line = Buffer.from(value, 'utf8').equals(secret.value) ? dotenvLine(name, value) : null;
      if (line) lines.push(line);
      else left.push(name);
    }
  } finally {
    state.key?.fill(0);
    for (const secret of state.secrets) secret.value.fill(0);
  }
  writeNewPrivate(path, lines.length ? `${lines.join('\n')}\n` : '');
  return [
    `Wrote ${relative(cwd, path) || path} (private to you) with ${lines.length} names from Development.`,
    ...(left.length ? [`Not written, no dotenv form keeps their bytes: ${list(left)}.`] : []),
  ];
}
