// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { HostedOutputRedactor } from '../dist/hosted-output-redactor.js';

export function assertSmokeImport(job, secrets = []) {
  assert(job, 'Owned native import is unavailable.');
  assert.notEqual(
    job.phase,
    'error',
    `Owned native source acquisition failed: ${sanitizeSmokeText(job.error ?? 'No import error was recorded.', secrets)}`,
  );
}

export function sanitizeSmokeText(value, secrets = []) {
  let text = stripVTControlCharacters(String(value ?? ''));
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length))
    text = text.replaceAll(stripVTControlCharacters(secret), '[redacted]');
  text = text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[redacted]')
    // Never echo dotenv contents, even when the variable name is unfamiliar.
    .replace(/^\s*(?:export\s+)?[A-Z][A-Z0-9_]*\s*=.*$/gm, '[environment assignment redacted]')
    .replace(/\b(?:oidc|native)-synthetic-[a-f0-9-]+/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/\b[\da-f]{64,}\b/gi, '[redacted]')
    .replace(/\b(authorization|proxy-authorization)\s*:\s*[^\r\n]+/gi, '$1: [redacted]')
    .replace(
      /\b[\w.-]*(?:token|secret|password|api[_-]?key|admin[_-]?key)\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '[redacted]',
    )
    .replace(/(https?:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/gi, '$1[redacted]');
  const redactor = new HostedOutputRedactor({ secrets, paths: [] });
  text = Buffer.concat([redactor.write(Buffer.from(text)), redactor.end()]).toString('utf8');
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

export function smokeCommand(command, args, options, label) {
  try {
    return execFileSync(command, args, options);
  } catch (error) {
    // execFileSync's message includes argv. Only the fixed label and stderr may be published.
    error.smokeCommand = label;
    throw error;
  }
}

export function smokeFailure(error, { stage, secrets = [], command, stderr } = {}) {
  const exit = error?.status ?? error?.exitCode;
  const processError = error?.smokeCommand || error?.spawnargs || error?.cmd || exit != null;
  const reason = stderr ?? error?.stderr ?? (processError ? '' : error?.message);
  const tail = sanitizeSmokeText(reason, secrets)
    .split(/\r?\n/)
    .filter(line => line.trim())
    .slice(-12);
  return sanitizeSmokeText(
    [
      `Native self-host smoke failed during ${stage}.`,
      `Command: ${error?.smokeCommand ?? command ?? 'in-process smoke check'}; exit code: ${exit ?? 'unavailable'}${error?.signal ? `; signal: ${error.signal}` : ''}${error?.code ? `; code: ${error.code}` : ''}.`,
      tail.length
        ? `Sanitized diagnostic tail:\n${tail.map(line => `  ${line.slice(0, 600)}`).join('\n')}`
        : 'No stderr was captured.',
    ].join('\n'),
    secrets,
  );
}

/** Bytes always go to R2 (self-host included): `r2` names the bucket settings, here a local
 * S3-compatible fake reached through R2_ENDPOINT. */
export function deploySmoke(cli, { issuer, token, keys, r2 }) {
  cli(['env', 'set', 'CLERK_JWT_ISSUER_DOMAIN', issuer]);
  // Convex rejects reads of unset auth-config variables, including guarded optional reads.
  cli(['env', 'set', 'FORGE_CLI_ISSUER', '']);
  cli(['env', 'set', 'GITHUB_PUBLIC_TOKEN', token]);
  cli(['env', 'set', 'FORGE_SECRET_KEYS', keys]);
  for (const [name, value] of Object.entries(r2)) cli(['env', 'set', name, value]);
  cli(['deploy', '--typecheck', 'enable', '--yes']);
}
