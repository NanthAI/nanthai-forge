// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { invariant } from './errors.js';
import { landSaveCommand, lifecycleVerbs, lowerVerb, parseVerbForm, verbModes } from './agent-verbs.js';

type Verb = (typeof lifecycleVerbs)[number];
const isVerb = (value: unknown): value is Verb =>
  (lifecycleVerbs as readonly string[]).includes(value as string);

/** MCP mode names are the CLI mode flags without the dashes. */
export function mcpModes(verb: Verb, hosted: boolean, wireActions: readonly string[]): string[] {
  return Object.keys(verbModes[verb])
    .filter(flag => wireActions.includes(lowerVerb({ verb, flags: [flag], operator: false }, hosted)))
    .map(flag => flag.slice(2));
}

/**
 * Compact input for one start/save/land form; every other field is the lowered action's own field, so
 * the existing action schemas stay the one source of truth and the tool listing stays small. `mode` is
 * optional only where the bare verb is itself an action (`save`).
 */
export function verbInputSchemas(
  hosted: boolean,
  wireActions: readonly string[],
  withPlainSave: boolean,
): z.ZodObject[] {
  return lifecycleVerbs.flatMap(verb => {
    const modes = mcpModes(verb, hosted, wireActions);
    const plain = verb === 'save' && withPlainSave;
    if (!modes.length && !plain) return [];
    const mode = modes.length ? z.enum(modes as [string, ...string[]]) : undefined;
    return [
      z
        .object({
          action: z.literal(verb),
          ...(mode ? { mode: plain ? mode.optional() : mode } : {}),
          ...(verb === 'land' ? { checkOnly: z.boolean().optional() } : {}),
        })
        .catchall(z.unknown()),
    ];
  });
}

/**
 * Lower `{action: start|save|land, mode?, checkOnly?}` to the existing wire command before dispatch,
 * with the same rules as the CLI (`land --save` accept defaults, check-only refusal). Any other command
 * returns unchanged, so old action names keep working. MCP results never carry alias notices.
 * Natively, `land` mode `save` resumes a retained finish: pass `retained` to read it.
 */
export function lowerMcpCommand(
  command: Record<string, unknown>,
  hosted: boolean,
  retained?: (operationId: string) => Record<string, unknown> | undefined,
): Record<string, unknown> {
  const { action, mode, checkOnly, ...rest } = command;
  if (!isVerb(action) || (action !== 'save' && mode === undefined && checkOnly === undefined)) return command;
  invariant(
    mode === undefined || (typeof mode === 'string' && Object.hasOwn(verbModes[action], `--${mode}`)),
    'BAD_ARGUMENT',
    `Unknown ${action} mode.`,
  );
  invariant(
    checkOnly === undefined || typeof checkOnly === 'boolean',
    'BAD_ARGUMENT',
    'checkOnly is boolean.',
  );
  const flags = [
    ...(mode === undefined ? [] : [`--${mode as string}`]),
    ...(checkOnly ? ['--check-only'] : []),
  ];
  const [form, left] = parseVerbForm(action, flags);
  invariant(!left.length, 'BAD_ARGUMENT', `Unknown ${action} mode.`);
  const wire = lowerVerb(form, hosted);
  const operationId = typeof rest.operationId === 'string' ? rest.operationId : undefined;
  const original = !hosted && wire === 'finish' && operationId ? retained?.(operationId) : undefined;
  return { ...original, ...landSaveCommand(form, hosted, rest, original), action: wire };
}
