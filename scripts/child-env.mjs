// SPDX-License-Identifier: Apache-2.0
// Ordinary OS settings only. Credentials and application configuration are opt-in.
const runtimeNames = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'TZ',
  'USER',
  'LOGNAME',
  'SHELL',
  'SystemRoot',
  'WINDIR',
  'PATHEXT',
  'COMSPEC',
];
export const localeEnvNames = [
  'LC_ALL',
  'LC_CTYPE',
  'LC_COLLATE',
  'LC_MESSAGES',
  'LC_NUMERIC',
  'LC_MONETARY',
  'LC_TIME',
  'LC_PAPER',
  'LC_NAME',
  'LC_ADDRESS',
  'LC_TELEPHONE',
  'LC_MEASUREMENT',
  'LC_IDENTIFICATION',
];
export function childEnv({ allow = [], extra = {}, source = process.env, platform = process.platform } = {}) {
  // Windows environment names are case-insensitive (Path/ComSpec are common).
  const key = name => (platform === 'win32' ? name.toUpperCase() : name);
  const names = new Set([...runtimeNames, ...localeEnvNames, ...allow].map(key));
  const env = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && names.has(key(name))) env[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) {
    for (const existing of Object.keys(env)) if (key(existing) === key(name)) delete env[existing];
    if (value !== undefined) env[name] = value;
  }
  return env;
}
