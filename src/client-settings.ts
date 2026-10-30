// SPDX-License-Identifier: Apache-2.0
import { cpus, homedir, totalmem } from 'node:os';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ForgeError, invariant } from './errors.js';

/** Machine-local parallel-work defaults (docs/parallel-work-defaults.md). They live beside
 * the saved login in the Forge config directory; project policy stays on the server. */
export const clientSettingsSchema = z
  .object({
    /** Remove local roots of landed/abandoned Lanes idle this long, on start. 0 = off. */
    autoPruneHours: z.number().nonnegative().finite().default(3),
    /** start lists your open Lanes with no Forge action for this long. 0 = off. */
    idleLaneHours: z.number().nonnegative().finite().default(1),
    /** Machine-wide slots for `nforge heavy`; auto derives from RAM and cores. 0 = off. */
    localHeavySlots: z.union([z.literal('auto'), z.number().int().nonnegative()]).default('auto'),
    /** Lane open links node_modules to one install per lockfile hash. */
    shareDependencies: z.boolean().default(true),
    /** land --save waits for the outcome and prints a compact failure summary. */
    landWait: z.boolean().default(true),
  })
  .strict();
export type ClientSettings = z.infer<typeof clientSettingsSchema>;
export const clientSettingKeys = Object.keys(clientSettingsSchema.shape) as (keyof ClientSettings)[];

export function forgeConfigDirectory() {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'forge');
}
export function clientSettingsFile() {
  return process.env.FORGE_CLIENT_SETTINGS || join(forgeConfigDirectory(), 'client.json');
}
function stored(): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(clientSettingsFile(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  try {
    const value = JSON.parse(text) as unknown;
    invariant(value && typeof value === 'object' && !Array.isArray(value), 'BAD_ARGUMENT', 'not an object');
    return value as Record<string, unknown>;
  } catch {
    throw new ForgeError('CLIENT_SETTINGS_INVALID', `Fix or delete ${clientSettingsFile()}.`);
  }
}
export function readClientSettings(): ClientSettings {
  const parsed = clientSettingsSchema.safeParse(stored());
  invariant(parsed.success, 'CLIENT_SETTINGS_INVALID', `Fix or delete ${clientSettingsFile()}.`);
  return parsed.data;
}
/** 16 GB / 8 cores -> 3: one heavy build or test run per ~5 GB, at most half the cores. */
export function heavySlots(
  setting: ClientSettings['localHeavySlots'],
  memory = totalmem(),
  cores = cpus().length,
) {
  if (setting !== 'auto') return setting;
  return Math.max(1, Math.min(Math.floor(memory / (5 * 2 ** 30)), Math.floor(cores / 2)));
}
function parseValue(key: keyof ClientSettings, value: string): unknown {
  if (key === 'shareDependencies' || key === 'landWait') {
    invariant(value === 'true' || value === 'false', 'BAD_ARGUMENT', `${key} is true or false.`);
    return value === 'true';
  }
  if (key === 'localHeavySlots' && value === 'auto') return value;
  const number = Number(value);
  invariant(value.trim() !== '' && Number.isFinite(number), 'BAD_ARGUMENT', `${key} is a number.`);
  return number;
}
/** nforge settings [KEY [VALUE | --reset]] */
export function clientSettingsCli(args: string[]) {
  invariant(args.length <= 2, 'BAD_ARGUMENT', 'Use settings [KEY [VALUE | --reset]].');
  const [key, value] = args;
  if (key !== undefined)
    invariant(
      (clientSettingKeys as string[]).includes(key),
      'BAD_ARGUMENT',
      `Settings: ${clientSettingKeys.join(', ')}.`,
    );
  if (key !== undefined && value !== undefined) {
    const next = { ...stored() };
    if (value === '--reset') delete next[key];
    else next[key] = parseValue(key as keyof ClientSettings, value);
    const parsed = clientSettingsSchema.safeParse(next);
    invariant(parsed.success, 'BAD_ARGUMENT', `Invalid ${key}.`);
    const file = clientSettingsFile(),
      temporary = `${file}.${randomUUID()}`;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  }
  const current = stored(),
    effective = readClientSettings();
  const entries = (key ? [key] : clientSettingKeys) as (keyof ClientSettings)[];
  return {
    file: clientSettingsFile(),
    settings: Object.fromEntries(
      entries.map(name => [
        name,
        {
          value: effective[name],
          source: Object.hasOwn(current, name) ? 'file' : 'default',
          ...(name === 'localHeavySlots' ? { slots: heavySlots(effective.localHeavySlots) } : {}),
        },
      ]),
    ),
  };
}
