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

/** Where a runner image or a setup action put a toolchain (docs/operations/github-actions-checks.md#toolchain-variables).
 * Locations only: none of these holds a credential, and no name with TOKEN, SECRET, PASSWORD,
 * CREDENTIAL, AUTH or KEY ever passes, whatever a pattern matches. */
export const toolchainEnvNames = [
  'JAVA_HOME',
  'GOROOT',
  'GOPATH',
  'GOMODCACHE',
  'GOCACHE',
  'pythonLocation',
  'Python_ROOT_DIR',
  'Python2_ROOT_DIR',
  'Python3_ROOT_DIR',
  'PKG_CONFIG_PATH',
  'LD_LIBRARY_PATH',
  'DOTNET_ROOT',
  'NUGET_PACKAGES',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'ANDROID_HOME',
  'ANDROID_SDK_ROOT',
  'ANDROID_NDK',
  'ANDROID_NDK_HOME',
  'ANDROID_NDK_ROOT',
  'ANDROID_NDK_LATEST_HOME',
  'GRADLE_HOME',
  'GRADLE_USER_HOME',
  'MAVEN_HOME',
  'M2_HOME',
  'CONDA',
  'VCPKG_INSTALLATION_ROOT',
];
/** Versioned image locations such as JAVA_HOME_21_X64 or GOROOT_1_23_X64. */
export const toolchainEnvPattern = /^(?:JAVA_HOME|GOROOT)_[0-9]+(?:_[0-9]+)*_(?:X64|ARM64)$/;
const credentialName = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|KEY/i;
/** Toolchain variable names present in `source`, for `childEnv({ allow })`. */
export function toolchainEnvAllow(source = process.env) {
  return Object.keys(source).filter(
    name =>
      (toolchainEnvNames.includes(name) || toolchainEnvPattern.test(name)) && !credentialName.test(name),
  );
}
