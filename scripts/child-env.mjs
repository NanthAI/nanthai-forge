// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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
  // flutter-action exports it; without it the flutter tool unpacks and deletes the SDK's own
  // .pub-preload-cache on first run, which the Candidate user may not delete.
  'PUB_CACHE',
];
/** Versioned image locations such as JAVA_HOME_21_X64 or GOROOT_1_23_X64, and setup-beam's install
 * roots (INSTALL_DIR_FOR_OTP, INSTALL_DIR_FOR_ELIXIR, ...). */
export const toolchainEnvPattern =
  /^(?:(?:JAVA_HOME|GOROOT)_[0-9]+(?:_[0-9]+)*_(?:X64|ARM64)|INSTALL_DIR_FOR_[A-Z0-9]+)$/;
const credentialName = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|KEY/i;
/** Documented, non-secret variables the CI sets on every job, per adapter that runs Forge's fixed
 * supervisor (docs/operations/github-actions-checks.md#runner-variables), so a configured command
 * sees the same runner description as the same job on that CI. Left out on purpose: tokens and
 * ACTIONS_*; the workflow command files (GITHUB_ENV, GITHUB_OUTPUT, GITHUB_PATH, GITHUB_STATE,
 * GITHUB_STEP_SUMMARY), through which a step changes later steps; GITHUB_EVENT_PATH (the dispatch
 * inputs); GITHUB_SHA, GITHUB_REF* and the workflow ref, which describe Forge's dispatch, not the
 * Candidate; and runner-private folders (RUNNER_TEMP, RUNNER_TOOL_CACHE). The supervisor points
 * GITHUB_WORKSPACE at the Candidate checkout. GitLab CI runs the project's own CI file
 * (src/ci-status.ts), which keeps its own variables, so it needs no list. */
export const runnerEnvNames = {
  'github-actions': [
    'GITHUB_ACTIONS',
    'GITHUB_ACTOR',
    'GITHUB_ACTOR_ID',
    'GITHUB_API_URL',
    'GITHUB_EVENT_NAME',
    'GITHUB_GRAPHQL_URL',
    'GITHUB_JOB',
    'GITHUB_REPOSITORY',
    'GITHUB_REPOSITORY_ID',
    'GITHUB_REPOSITORY_OWNER',
    'GITHUB_REPOSITORY_OWNER_ID',
    'GITHUB_RETENTION_DAYS',
    'GITHUB_RUN_ATTEMPT',
    'GITHUB_RUN_ID',
    'GITHUB_RUN_NUMBER',
    'GITHUB_SERVER_URL',
    'GITHUB_TRIGGERING_ACTOR',
    'GITHUB_WORKFLOW',
    'GITHUB_WORKSPACE',
    'RUNNER_ARCH',
    'RUNNER_DEBUG',
    'RUNNER_ENVIRONMENT',
    'RUNNER_NAME',
    'RUNNER_OS',
  ],
};
/** Runner variable names present in `source`, for `childEnv({ allow })`. */
export function runnerEnvAllow(source = process.env) {
  // The adapter whose runner this process is on.
  const adapter = source.GITHUB_ACTIONS === 'true' ? 'github-actions' : null;
  return (adapter ? runnerEnvNames[adapter] : []).filter(
    name => source[name] !== undefined && !credentialName.test(name),
  );
}
/** Toolchain variable names present in `source`, for `childEnv({ allow })`. */
export function toolchainEnvAllow(source = process.env) {
  return Object.keys(source).filter(
    name =>
      (toolchainEnvNames.includes(name) || toolchainEnvPattern.test(name)) && !credentialName.test(name),
  );
}
