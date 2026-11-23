// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isBrowserTest } from './test-browser-names.mjs';
import { runFiles } from './test-files.mjs';

// Include absolute calendar fixtures even when only the code under test reads the clock.
// Also include retention/expiry tests whose dates may come from helpers or numeric stamps.
const dateSensitive =
  /\b\d{4}-\d{2}-\d{2}|\bDate\.UTC\s*\(|\bnew\s+Date\s*\(\s*\d{4}\s*,|\b[12](?:_?\d){9}(?:(?:_?\d){3})?\b|\b(?:retention|cutoff|expir\w*|time[- ]window|day[- ]close|UTC[- ]day)\b/i;
const files = readdirSync('tests')
  .filter(name => name.endsWith('.test.mjs'))
  .map(name => `tests/${name}`)
  .filter(file => !isBrowserTest(file) && dateSensitive.test(readFileSync(file, 'utf8')))
  .sort();
if (!files.length) throw new Error('No date-sensitive Node tests found.');

// A path anchored here also works when a test spawns Node in a temporary directory.
const preload = fileURLToPath(new URL('../tests/shifted-clock.mjs', import.meta.url));
process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(preload)}`.trim();
console.log(`Running ${files.length} test files with the ambient clock advanced 30 days.`);
process.exitCode = (await runFiles(files)) ? 0 : 1;
