// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const retiredCommand = /nforge\s+work\b|\b(?:restore-native|restore-work|export-work|define-check)\b/;

test('copyable web commands cannot recommend the retired native CLI (journey defect 7)', () => {
  // Also catch the old JSX branch that assembled the command from sourceKind.
  assert(retiredCommand.test("nforge {sourceKind === 'native' ? 'restore-native' : 'restore-work'} ARCHIVE"));
  function scan(url) {
    for (const entry of readdirSync(url, { withFileTypes: true })) {
      const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), url);
      if (entry.isDirectory()) scan(path);
      else if (/\.tsx?$/.test(entry.name))
        assert.equal(retiredCommand.test(readFileSync(path, 'utf8')), false, path.pathname);
    }
  }
  scan(new URL('../web/src/', import.meta.url));
});

test('top-level help separates hosted landing queue from local command recovery', () => {
  const help = execFileSync(process.execPath, ['dist/cli.js', '--help'], { encoding: 'utf8' });
  assert.doesNotMatch(help, /offline Git adoption/);
  assert.match(help, /nforge agent ROOT queue/);
  assert.match(help, /nforge queue[^\n]*# local command recovery/);
  assert.doesNotMatch(help, retiredCommand);
});
