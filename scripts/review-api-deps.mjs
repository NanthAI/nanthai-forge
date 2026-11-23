// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The real nforge/keychain/network edges of the review scripts (Items f082efd6, 3bd3eb0f).
import { execFile, execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { promisify } from 'node:util';
import { DEFAULTS, ReviewError } from './review-api-lib.mjs';

const run = promisify(execFile);

/** The real nforge/keychain/network edges; tests pass fakes for each. */
export const realDeps = {
  async nforge(lane, action, json) {
    const { stdout } = await run('nforge', ['agent', lane, action, JSON.stringify(json)], {
      maxBuffer: 32 << 20,
    });
    const line = stdout
      .split('\n')
      .reverse()
      .find(l => l.startsWith('{'));
    if (!line) throw new ReviewError('REVIEW_NFORGE', `nforge ${action} printed no JSON.`);
    const parsed = JSON.parse(line);
    if (parsed.error)
      throw new ReviewError('REVIEW_NFORGE', `nforge ${action}: ${parsed.error.code ?? 'error'}.`);
    return parsed;
  },
  readKey(service) {
    try {
      return execFileSync('security', ['find-generic-password', '-s', service, '-a', 'forge', '-w'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim();
    } catch {
      return '';
    }
  },
  // Plain Node with no dist/ helper (builders run this from a Lane): one POST per attempt, deadline set
  // by the caller. A retry is only for 429/5xx or unusable GPT text, under the caps. Exempt as
  // 'standalone' in check-network-boundaries.
  request: (url, init) => globalThis.fetch(url, { ...init, signal: AbortSignal.timeout(DEFAULTS.timeoutMs) }),
  /** Pause before the one retry of a 429/5xx. */
  backoff: ms => new Promise(resolve => setTimeout(resolve, ms)),
  /** A regular file that really lives under `root` (no symlink, no `..`), as UTF-8 text; else null. */
  readText(root, rel) {
    try {
      const path = join(root, rel);
      const inside = realpathSync(path).startsWith(`${realpathSync(root)}${sep}`);
      if (!inside || !lstatSync(path).isFile()) return null;
      const text = readFileSync(path, 'utf8');
      return text.includes('\0') ? null : text;
    } catch {
      return null;
    }
  },
  /** Local routing/credit overrides (see CONFIG in review-api-lib.mjs); {} when the file is absent. */
  localConfig(file = process.env.FORGE_REVIEW_CONFIG ?? join(homedir(), '.forge-review', 'config.json')) {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      throw new ReviewError('REVIEW_CONFIG', `Cannot read review config ${file}: ${error?.name ?? 'error'}.`);
    }
  },
  spendLog: process.env.FORGE_REVIEW_SPEND_LOG ?? join(homedir(), '.forge-review', 'spend.jsonl'),
  now: () => new Date(),
  out: text => process.stdout.write(`${text}\n`),
};
