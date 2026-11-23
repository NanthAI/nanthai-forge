// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Antigravity keeps user hooks and MCP servers in ~/.gemini/config/. It treats an agent editing them as
// guardrail tampering, so only the person-run `nforge connect antigravity` writes them, never the
// automatic hook install that every CLI run makes for Claude Code and Codex.
import { isDeepStrictEqual } from 'node:util';
import { dirname, join } from 'node:path';
import { invariant } from './errors.js';
import { shellQuote } from './shell-quote.js';
import { ANTIGRAVITY_EDIT_TOOLS } from './agent-antigravity-tools.js';

export const ANTIGRAVITY_HOOKS = '.gemini/config/hooks.json';
export const ANTIGRAVITY_MCP = '.gemini/config/mcp_config.json';
/** Antigravity hooks.json is keyed by hook name: Forge owns exactly this key. */
export const ANTIGRAVITY_HOOK_NAME = 'forge-first-write';

/** The hook entry for an installed first-write runner (`…/current/dist/agent-edit-hook.js`). */
export function antigravityHookEntry(editRunner: string) {
  const command = [
    process.execPath,
    join(dirname(editRunner), 'agent-antigravity-hook.js'),
    '--forge-first-write',
  ]
    .map(shellQuote)
    .join(' ');
  return {
    PostToolUse: [
      {
        matcher: `^(${ANTIGRAVITY_EDIT_TOOLS.join('|')})$`,
        hooks: [{ type: 'command', command, timeout: 5 }],
      },
    ],
    PreInvocation: [{ type: 'command', command, timeout: 5 }],
  };
}

/** Forge's two MCP servers in the user config: hosted Work tools and the coordination tools. */
export const ANTIGRAVITY_MCP_KEYS = ['forge', 'forge-coordination'] as const;
type Under = 'mcpServers' | null;

function parse(file: string, text: string | null) {
  if (text === null || !text.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = null;
  }
  invariant(
    value && typeof value === 'object' && !Array.isArray(value),
    'BAD_ARGUMENT',
    `Antigravity ${file} must be a JSON object. Fix it, then retry.`,
  );
  return value as Record<string, unknown>;
}

/** Forge's keys as `text` holds them (undefined where absent): what undo puts back. */
export function forgeKeys(file: string, text: string | null, under: Under, keys: readonly string[]) {
  const config = parse(file, text);
  const target = (under ? config[under] : config) as Record<string, unknown> | undefined;
  return Object.fromEntries(keys.map(key => [key, target?.[key]]));
}

/** Set (a value) or remove (undefined) exactly these keys, at the top level or under `mcpServers`.
 * Every other key is kept; when nothing changes the original text comes back byte for byte. */
export function editForgeKeys(
  file: string,
  before: string | null,
  under: Under,
  values: Record<string, unknown>,
) {
  const config = parse(file, before);
  const existing = under ? config[under] : config;
  invariant(
    existing === undefined || (typeof existing === 'object' && existing && !Array.isArray(existing)),
    'BAD_ARGUMENT',
    `Antigravity ${file} ${under} must be a JSON object. Fix it, then retry.`,
  );
  const target = (existing ?? {}) as Record<string, unknown>;
  let changed = false;
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined ? !Object.hasOwn(target, key) : isDeepStrictEqual(target[key], value)) continue;
    changed = true;
    if (value === undefined) delete target[key];
    else target[key] = value;
  }
  if (!changed) return before;
  if (under) config[under] = target;
  return JSON.stringify(config, null, 2) + '\n';
}

/** hooks.json with Forge's entry set (runner) or removed (null). Other hooks are kept as they are. */
export const editAntigravityHooks = (before: string | null, editRunner: string | null) =>
  editForgeKeys(ANTIGRAVITY_HOOKS, before, null, {
    [ANTIGRAVITY_HOOK_NAME]: editRunner ? antigravityHookEntry(editRunner) : undefined,
  });

/** Read-only coverage: the installed runner path when Forge's entry exists, else null. */
export function antigravityHookRunner(text: string | null) {
  let config: Record<string, unknown>;
  try {
    config = parse(ANTIGRAVITY_HOOKS, text);
  } catch {
    return { installed: false as const, unreadable: true as const };
  }
  const entry = config[ANTIGRAVITY_HOOK_NAME] as
    | { PostToolUse?: { hooks?: { command?: unknown }[] }[] }
    | undefined;
  const command = entry?.PostToolUse?.[0]?.hooks?.[0]?.command;
  return typeof command === 'string' ? { installed: true as const, command } : { installed: false as const };
}
