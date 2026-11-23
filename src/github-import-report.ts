// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The pre-import report (Item a488af2a): what a GitHub import will bring across and which of the existing
// limits already apply, said before any work begins. It states today's envelope and adds no quota: the numbers
// come from the source-step envelope (src/source-state-size.ts) and the import's Git LFS rule
// (src/github-import-pages.ts). The web, the CLI and the server use this one wording.
import { sourceStateLimits } from './source-state-size.js';
import { lfsImportDefaultBytes, lfsImportMaxBytes } from './github-import-pages.js';
import { importStaysLine } from './migration-ledger.js';

export type ImportVisibility = 'public' | 'private';
/** `code` names the existing refusal a warning foresees (SOURCE_STATE_TOO_LARGE); null for a notice. */
export type ImportWarning = { code: string | null; message: string };
export type ImportPreview = {
  repository: string;
  /** GitHub's visibility; the import's default. */
  origin: ImportVisibility;
  /** What the person may choose here: a public origin may import private; a private one stays private. */
  choices: ImportVisibility[];
  ref: string;
  commit: string;
  /** Files at the commit, or null when GitHub lists the tree only in parts (known once the import starts). */
  files: number | null;
  bytes: number | null;
  submodules: number | null;
  /** `.gitattributes` files at the commit: Git LFS can apply only when there is one. */
  attributes: number | null;
  lfs: string;
  warnings: ImportWarning[];
};

const n = new Intl.NumberFormat('en-US');
const gib = (bytes: number) => `${n.format(Math.round((bytes / 1024 ** 3) * 10) / 10)} GiB`;

/** The visibility a request may set: none keeps GitHub's; a private repository never becomes public here. */
export function importVisibilityChoices(origin: ImportVisibility): ImportVisibility[] {
  return origin === 'public' ? ['public', 'private'] : ['private'];
}

/** What happens to Git LFS files, from the existing rule. `attributes` null: not known before the import. */
export function importLfsLine(attributes: number | null, lfsLimitBytes = lfsImportDefaultBytes) {
  if (attributes === 0) return 'No .gitattributes, so no Git LFS files.';
  if (lfsLimitBytes === 0) return 'Git LFS files stay pointers (lfsLimitBytes 0).';
  return `Git LFS files come across as the real files, up to ${gib(lfsLimitBytes)} per import (at most ${gib(lfsImportMaxBytes)}, or 0 to keep pointers); above that the import stops before main is published (GITHUB_LFS_LIMIT).`;
}

/** The existing source-step envelope, said for this file count. The smallest step crossed is named. */
export function importEnvelopeWarnings(files: number | null): ImportWarning[] {
  if (files === null)
    return [
      {
        code: null,
        message:
          'GitHub lists this tree only in parts, so the file count is known once the import starts. Nothing is published unless all of it arrives.',
      },
    ];
  const steps = [
    ['sync', 'syncing a Lane with main'],
    ['compose', 'landing'],
    ['save', 'saving'],
  ] as const;
  const crossed = steps.filter(([step]) => files > sourceStateLimits[step].fileCount);
  if (!crossed.length) return [];
  const [step, doing] = crossed[0]!;
  return [
    {
      code: 'SOURCE_STATE_TOO_LARGE',
      message: `${n.format(files)} files is above the ${n.format(sourceStateLimits[step].fileCount)} files Forge supports for ${doing} today. The import can finish, but ${doing} on this project is refused (SOURCE_STATE_TOO_LARGE) until the repository is split or the limit rises.`,
    },
  ];
}

/** One plain line for the CLI and the web: what comes across, and the first warning. */
export function importPreviewLine(preview: ImportPreview) {
  const files = preview.files === null ? 'files' : `${n.format(preview.files)} files`;
  const first = preview.warnings[0];
  return `${preview.repository} at ${preview.ref} (${preview.commit.slice(0, 7)}): ${files} and the full history come across; ${preview.origin} on GitHub${preview.choices.length > 1 ? ', can import private' : ', imports private'}.${first ? ` ${first.message}` : ''} ${importStaysLine}`;
}
