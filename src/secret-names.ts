// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { ForgeError } from './errors.js';
/** Release-owned lists. These are depth behind the tree's .env.example, not a complete
 * inventory of variables that affect programs. Projects cannot override the lists. */
export const secretNameRules = {
  denied: `PATH HOME SHELL ENV BASH_ENV IFS PS4 PROMPT_COMMAND LD_* DYLD_* NODE_OPTIONS
NODE_PATH PYTHON* PERL5* RUBYOPT RUBYLIB JAVA_TOOL_OPTIONS _JAVA_OPTIONS GIT_* SSH_*
NPM_CONFIG_* EDITOR VISUAL PAGER TMPDIR CI FORGE_* ZDOTDIR GCONV_PATH GLIBC_TUNABLES
LOCPATH NLSPATH XDG_* USERPROFILE APPDATA LOCALAPPDATA TEMP TMP COMSPEC PATHEXT
PSMODULEPATH SYSTEMROOT JDK_JAVA_OPTIONS JAVA_HOME MAVEN_OPTS GRADLE_OPTS DOTNET_*
CORECLR_* COMPLUS_* OPENSSL_* NODE_* YARN_* COREPACK_* BUN_* DENO_* CARGO_* RUSTC*
RUSTDOC* RUSTFLAGS RUSTUP_* GOFLAGS GOPROXY GOPATH GOROOT GOENV GOTOOLCHAIN GOSUMDB
GONOSUMDB GONOSUMCHECK GOINSECURE PIP_* UV_* GEM_* BUNDLE_* PHPRC PHP_INI_SCAN_DIR
LUA_INIT* LUA_PATH* LUA_CPATH* LESSOPEN LESSCLOSE BROWSER CURL_HOME WGETRC NETRC
DOCKER_HOST DOCKER_CONFIG DOCKER_CONTEXT DOCKER_CERT_PATH DOCKER_TLS_VERIFY KUBECONFIG
GOAUTH GOPRIVATE GONOPROXY GOVCS GODEBUG GOCACHE GOMODCACHE GOBIN GOWORK CGO_* CC CXX LD
AR MAKEFLAGS MAKEFILES CMAKE_* PKG_CONFIG_* LIBRARY_PATH CPATH CLASSPATH JAVA_OPTS
SBT_OPTS ANT_OPTS TAR_OPTIONS ERL_FLAGS ERL_AFLAGS ERL_ZFLAGS ELIXIR_ERL_OPTIONS FPATH
SHELLOPTS BASHOPTS CDPATH EXINIT VIMINIT PERLLIB ELECTRON_RUN_AS_NODE COMPOSER_HOME
SSLKEYLOGFILE HOSTALIASES RES_OPTIONS LOCALDOMAIN`.split(/\s+/),
  routing: `*_PROXY NO_PROXY NODE_EXTRA_CA_CERTS SSL_CERT_* CURL_CA_BUNDLE
REQUESTS_CA_BUNDLE *_ENDPOINT_URL *_ENDPOINT_URL_* NODE_TLS_REJECT_UNAUTHORIZED
*_CA_BUNDLE *_CA_FILE PGSSL* PIP_INDEX_URL PIP_EXTRA_INDEX_URL UV_INDEX_URL
UV_EXTRA_INDEX_URL`.split(/\s+/),
  exceptions: `NODE_ENV NODE_AUTH_TOKEN CARGO_REGISTRY_TOKEN CARGO_REGISTRIES_*_TOKEN
GEM_HOST_API_KEY YARN_NPM_AUTH_TOKEN`.split(/\s+/),
} as const;
const compile = (pattern: string) => new RegExp(`^${pattern.split('*').join('.*')}$`);
const patterns = {
  denied: secretNameRules.denied.map(compile),
  routing: secretNameRules.routing.map(compile),
  exceptions: secretNameRules.exceptions.map(compile),
};
const exactExceptions = new Set<string>(secretNameRules.exceptions.filter(name => !name.includes('*')));
const exactRouting = new Set<string>(secretNameRules.routing.filter(name => !name.includes('*')));
const exactDenied = new Set<string>(secretNameRules.denied.filter(name => !name.includes('*')));
const matches = (name: string, list: readonly RegExp[]) => list.some(pattern => pattern.test(name));

export function secretNameKind(name: string): 'invalid' | 'denied' | 'routing' | 'credential' {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) return 'invalid';
  // Seven ordered rules: exact deny, exact exception, exact routing, exception
  // pattern, deny pattern, routing pattern, plain. The one Cargo token pattern
  // deliberately precedes CARGO_*; its index/provider neighbours remain denied.
  if (exactDenied.has(name)) return 'denied';
  if (exactExceptions.has(name)) return 'credential';
  if (exactRouting.has(name)) return 'routing';
  if (matches(name, patterns.exceptions)) return 'credential';
  if (matches(name, patterns.denied)) return 'denied';
  if (matches(name, patterns.routing)) return 'routing';
  return 'credential';
}

export type SecretNameNotice = { name: string; reason: string };

/** Parse declarations without interpreting or returning example values. */
export function parseSecretExample(text: string) {
  const names = new Set<string>();
  const notices: SecretNameNotice[] = [];
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const declaration = line.replace(/^export\s+/, '');
    const candidate = declaration.split(/[=\s#]/, 1)[0]!;
    // Only NAME, NAME=value and export NAME=value. An inline comment is allowed.
    const format = /^(?:export\s+)?([A-Z][A-Z0-9_]{0,63})(?:\s*=.*|\s*(?:#.*)?)$/.exec(line);
    const kind = secretNameKind(candidate);
    if (!format || kind === 'invalid' || kind === 'denied') {
      notices.push({
        name: candidate.replace(/[^A-Za-z0-9_]/g, '?').slice(0, 64) || '(invalid)',
        reason: kind === 'denied' ? 'denied name' : 'invalid declaration',
      });
      continue;
    }
    if (names.has(candidate)) notices.push({ name: candidate, reason: 'duplicate declaration' });
    names.add(candidate);
  }
  return { names: [...names], notices };
}

/** The name comes from a validated declaration or has already been quoted as a shell word. */
export const checksSetCommand = (name: string) => `nforge secret set ${name} --set checks`;

export function missingChecksNames(listed: readonly string[], present: readonly string[]) {
  const values = new Set(present);
  return listed.filter(name => !values.has(name));
}

/** Shared by future set/import/apply entry points and the current run path. */
export function secretNameRefusal(name: string, agentWrite = false): string | null {
  const kind = secretNameKind(name);
  if (kind === 'invalid') return 'invalid name';
  if (kind === 'denied') return 'denied name';
  return agentWrite && kind === 'routing' ? 'PERSON_REQUIRED' : null;
}

/** Value-free write boundary for the future set/import/apply adapters. Run never
 * emits a write notice merely for using a token. No value is an input here. */
export function checkSecretWriteName(
  name: string,
  options: {
    set: 'development' | 'checks';
    agent?: boolean;
    writeLine?: (line: string) => void;
  },
) {
  const refusal = secretNameRefusal(name, options.agent);
  if (refusal)
    throw new ForgeError(
      refusal === 'PERSON_REQUIRED' ? 'PERSON_REQUIRED' : 'BAD_ARGUMENT',
      `${name.replace(/[^A-Za-z0-9_]/g, '?').slice(0, 64)}: ${refusal}.`,
    );
  if (options.set === 'development' && name !== 'NODE_ENV' && matches(name, patterns.exceptions))
    (options.writeLine ?? (line => process.stderr.write(`${line}\n`)))(
      `${name}: this is a publish token; it belongs in Checks.`,
    );
}
