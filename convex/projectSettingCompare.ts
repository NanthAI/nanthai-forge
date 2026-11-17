// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { checkSetting } from './projectHostedCheckStore';
import { settingChange, type ApprovalRow } from './projectHostedApprovalStore';
import { effectivePolicy, editedPolicy, policyReadView, policyWriteSchema } from '../src/autonomy-policy';

/** What the owner compares on the approve page (Item 16093ed1): the setting as it is now and as the
 * request would leave it, in the same shape, so the page can draw readable before/after rows instead of
 * the raw request. `subject` names the one thing changed (a check's name). Owner page only: at most one
 * indexed read (the current check setting), none for policy, whose current value is on the project. */
type SettingCompare = { subject?: string; before: unknown; after: unknown };

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const parsed = (text: string | undefined) => {
  if (text === undefined) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};
const without = (fields: Record<string, unknown>, drop: readonly string[]) =>
  Object.fromEntries(Object.entries(fields).filter(([key]) => !drop.includes(key)));
/** A stored or imported check minus its identity fields, so it compares with a command. */
function checkFields(value: unknown) {
  const fields = record(value);
  return fields ? without(fields, ['id', 'at', 'definition']) : null;
}

export async function settingCompare(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
  row: ApprovalRow,
): Promise<SettingCompare | null> {
  const origin = row.setting?.origin;
  const change = record(settingChange(row));
  if (!origin || !change) return null;
  const stored = async (kind: 'definition' | 'runner', key: string) =>
    parsed((await checkSetting(ctx, project._id, kind, key))?.value);
  switch (origin) {
    case 'policy': {
      const before = effectivePolicy(project);
      const command = policyWriteSchema.safeParse(change);
      let after: unknown = null;
      // A request the current policy can no longer take still shows what it asked for.
      if (command.success)
        try {
          after = policyReadView(editedPolicy(before, command.data));
        } catch {
          after = null;
        }
      return { before: policyReadView(before), after };
    }
    case 'check-definition': {
      const asked = record(change.change);
      if (asked?.kind === 'import') {
        const check = record(asked.check);
        const id = typeof check?.id === 'string' ? check.id : '';
        return {
          subject: typeof check?.name === 'string' ? check.name : undefined,
          before: id ? checkFields(await stored('definition', id)) : null,
          after: checkFields(check),
        };
      }
      const command = record(asked?.command);
      const id = typeof asked?.checkId === 'string' ? asked.checkId : '';
      return {
        subject: typeof command?.name === 'string' ? command.name : undefined,
        before: id ? checkFields(await stored('definition', id)) : null,
        after: command,
      };
    }
    case 'runner': {
      const asked = record(change.change);
      return { before: await stored('runner', 'runner'), after: asked?.configuration ?? null };
    }
    case 'main-audit':
      return { before: await stored('runner', 'main-audit'), after: change.settings ?? null };
    case 'check-import': {
      // The imported definition is read from Work only when the grant runs; the page shows what is selected.
      const select = record(change.select);
      const id = typeof select?.checkId === 'string' ? select.checkId : '';
      return {
        subject: typeof select?.name === 'string' ? select.name : undefined,
        before: id ? checkFields(await stored('definition', id)) : null,
        after: select,
      };
    }
    case 'membership': {
      return { before: null, after: without(change, ['operationId']) };
    }
  }
}
