// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { secretNameRefusal } from './secret-names.js';
import type { SecretNameNotice } from './secret-env-example.js';

const runtimeControls = new Set([
  'FORGE_GIT_TIMEOUT_MS',
  'FORGE_CHECK_FULL',
  'FORGE_CHECK_SCOPED',
  'FORGE_MAX_CONCURRENT_CHECKS',
  'FORGE_CHECK_QUEUE_DIR',
  'FORGE_DISK_WARN_GB',
  'FORGE_DISK_BLOCK_GB',
]);
const sessionNames =
  /^(?:CLAUDE_CODE_SESSION_ID|CODEX_THREAD_ID|PI_SESSION_ID|OPENCODE_SESSION_ID|T3CODE_THREAD_ID|GEMINI_SESSION_ID|CRUSH_SESSION_ID|QWEN_CODE_SESSION_ID)$/i;
export type RunSecret = { name: string; kind: 'env' | 'file'; value: Buffer };
export function secretRunEnvironment(input: {
  source: NodeJS.ProcessEnv;
  names: readonly string[];
  secrets: readonly RunSecret[];
  only?: readonly string[] | undefined;
  platform?: NodeJS.Platform;
}) {
  const env: NodeJS.ProcessEnv = {};
  const key = (name: string) => (input.platform === 'win32' ? name.toUpperCase() : name);
  for (const [name, value] of Object.entries(input.source)) {
    if (/^(?:FORGE_|NFORGE_)/i.test(name) && !runtimeControls.has(name.toUpperCase())) continue;
    if (sessionNames.test(name)) continue;
    if (value !== undefined) env[name] = value;
  }
  const inherited = new Set(Object.keys(env).map(key));
  const names = new Set(input.names);
  const only = input.only === undefined ? null : new Set(input.only);
  const notices: SecretNameNotice[] = [];
  const supplied = new Set<string>();
  const selected: RunSecret[] = [];
  for (const secret of input.secrets) {
    const refusal = secretNameRefusal(secret.name);
    if (refusal) {
      notices.push({ name: secret.name.replace(/[^A-Za-z0-9_]/g, '?').slice(0, 64), reason: refusal });
      continue;
    }
    supplied.add(secret.name);
    if (!names.has(secret.name)) {
      notices.push({ name: secret.name, reason: 'arrives when its change lands' });
      continue;
    }
    if ((!only || only.has(secret.name)) && !inherited.has(key(secret.name))) selected.push(secret);
  }
  for (const name of names)
    if (!supplied.has(name) && !inherited.has(key(name))) notices.push({ name, reason: 'no value' });
  return { env, selected, notices };
}
