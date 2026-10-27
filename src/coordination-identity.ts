// SPDX-License-Identifier: Apache-2.0
import {
  coordinationHarnessSchema,
  type CoordinationHarness,
  type CoordinationSessionKind,
} from './coordination-types.js';

export type SessionDeclaration = {
  parentSessionId?: string;
  sessionKind: CoordinationSessionKind;
  harness: CoordinationHarness;
  harnessVersion?: string;
};
type ClientInfo = { name: string; version: string };
/** Client initialize metadata is preferred to the enclosing terminal's harness environment. */
export function detectHarness(
  env: NodeJS.ProcessEnv,
  client?: ClientInfo,
): Pick<SessionDeclaration, 'harness' | 'harnessVersion'> {
  const name = client?.name.toLowerCase() ?? '';
  let harness: CoordinationHarness | undefined;
  if (/claude/.test(name)) harness = 'claude-code';
  else if (/codex/.test(name)) harness = 'codex';
  else if (/cursor/.test(name)) harness = 'cursor';
  else if (/^pi(?:$|[-_ /])/.test(name)) harness = 'pi';
  if (harness) return { harness, ...(client?.version ? { harnessVersion: client.version } : {}) };
  const explicit = coordinationHarnessSchema.safeParse(env.FORGE_HARNESS);
  harness = explicit.success
    ? explicit.data
    : env.CLAUDECODE || env.CLAUDE_CODE
      ? 'claude-code'
      : env.CODEX_THREAD_ID
        ? 'codex'
        : env.CURSOR_AGENT || env.CURSOR_TRACE_ID
          ? 'cursor'
          : env.PI_CODING_AGENT_DIR
            ? 'pi'
            : 'other';
  const version =
    env.FORGE_HARNESS_VERSION ??
    {
      'claude-code': env.CLAUDE_CODE_VERSION,
      codex: env.CODEX_VERSION,
      cursor: env.CURSOR_VERSION,
      pi: env.PI_VERSION,
      other: undefined,
    }[harness];
  return { harness, ...(version ? { harnessVersion: version } : {}) };
}
/** Capture inherited parent once: publishing our own child environment must not make us our own parent. */
export function sessionDeclaration(
  env: NodeJS.ProcessEnv,
  client: () => ClientInfo | undefined = () => undefined,
) {
  const inherited = { ...env };
  return (
    input: {
      parentSessionId?: string | undefined;
      kind?: CoordinationSessionKind | undefined;
      harness?: CoordinationHarness | undefined;
      harnessVersion?: string | undefined;
    } = {},
    previous?: SessionDeclaration,
  ): SessionDeclaration => {
    const parentSessionId =
      input.parentSessionId ?? previous?.parentSessionId ?? inherited.FORGE_PARENT_SESSION;
    const detected = detectHarness(inherited, client());
    const harness = input.harness ?? previous?.harness ?? detected.harness;
    const harnessVersion =
      input.harnessVersion ??
      (harness === previous?.harness ? previous.harnessVersion : undefined) ??
      (harness === detected.harness ? detected.harnessVersion : undefined);
    return {
      ...(parentSessionId ? { parentSessionId } : {}),
      sessionKind: input.kind ?? previous?.sessionKind ?? (parentSessionId ? 'subagent' : 'agent'),
      harness,
      ...(harnessVersion ? { harnessVersion } : {}),
    };
  };
}
