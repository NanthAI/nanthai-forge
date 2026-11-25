// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 30_000;

function retryCode(stderr) {
  // cf prints its final API error in a box on stderr, with the HTTP status on its own row.
  const diagnostic = stripVTControlCharacters(stderr).match(/^┌ APIError\r?\n((?:│[^\n]*\n)+)└/m)?.[1];
  if (!diagnostic) return null;
  const status = diagnostic.match(/^│ (\d{3})(?:[ \t]|\r?$)/m)?.[1];
  if (status?.startsWith('4')) return null;
  if (/^│ (?:\[10013\]|.*\[code: 10013\])/m.test(diagnostic)) return 'API 10013';
  return status?.startsWith('5') ? `HTTP ${status}` : null;
}

function upload(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['inherit', 'inherit', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', chunk => {
      process.stderr.write(chunk);
      stderr = (stderr + chunk).slice(-16_384);
    });
    child.once('error', reject);
    child.once('close', status => resolve({ status: status ?? 1, stderr }));
  });
}

export async function deployWithRetry(run, { wait = setTimeout, log = console.error } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    const { status, stderr } = await run();
    if (status === 0 || attempt === MAX_ATTEMPTS) return status;
    const code = retryCode(stderr);
    if (!code) return status;
    log(`Cloudflare deploy attempt ${attempt + 1}/${MAX_ATTEMPTS} after ${code}`);
    await wait(RETRY_DELAY_MS);
  }
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  process.exitCode = await deployWithRetry(() => upload(command, args));
}
