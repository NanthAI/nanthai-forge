// SPDX-License-Identifier: Apache-2.0
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { WorkStore } from './work-store.js';
import { NativeSource } from './native-source.js';
import { workGit } from './work-git.js';
import { invariant } from './errors.js';
import { viewReadModels, viewContributors, whyNotes } from './view-read-model.js';
import { provenancePlan, type ProvenanceFile } from './view-provenance-plan.js';
import { readFileProvenance } from './view-provenance.js';
const page = {
  offset: z.number().int().nonnegative().safe().default(0),
  limit: z.number().int().positive().safe().default(20),
};
export const viewReadSchemas = [
  z.object({ action: z.literal('view'), viewId: z.string().uuid(), ...page }),
  z.object({
    action: z.literal('provenance'),
    viewId: z.string().uuid(),
    ...page,
    lines: z.boolean().default(false),
    file: z.string().optional(),
  }),
  z.object({ action: z.literal('views'), laneId: z.string().uuid(), ...page }),
] as const;
export const viewReadSchema = z.discriminatedUnion('action', viewReadSchemas);
export async function readView(store: WorkStore, input: z.input<typeof viewReadSchema>) {
  const command = viewReadSchema.parse(input);
  // Snapshot Work once: source heads are immutable and no read mutates Work.
  const data = store.load(),
    models = viewReadModels(data);
  const paginate = <T>(items: T[]) => ({
    items: items.slice(command.offset, command.offset + command.limit),
    total: items.length,
    nextOffset: command.offset + command.limit < items.length ? command.offset + command.limit : null,
  });
  if (command.action === 'views') {
    invariant(
      data.lanes.some(lane => lane.id === command.laneId),
      'NOT_FOUND',
      'Lane not found.',
    );
    return {
      revision: data.revision,
      result: {
        laneId: command.laneId,
        ...paginate(models.filter(view => view.inputs.some(i => i.laneId === command.laneId)).reverse()),
      },
    };
  }
  const view = data.views.find(view => view.id === command.viewId),
    model = models.find(view => view.viewId === command.viewId);
  invariant(view && model, 'NOT_FOUND', 'Candidate not found.');
  const source = store.native ? new NativeSource(store.root) : null;
  const states = new Map<string, ProvenanceFile[]>();
  const heads = new Set([view.base, ...(view.head ? [view.head] : [])]);
  for (const contributor of viewContributors(data, view)) {
    heads.add(contributor.head);
    for (const { save } of contributor.saves) {
      heads.add(save.parent);
      heads.add(save.head);
    }
  }
  for (const head of heads)
    states.set(
      head,
      source
        ? source.state(head).files
        : workGit(store.root, ['ls-tree', '-r', '-z', head])
            .split('\0')
            .filter(Boolean)
            .map(row => {
              const tab = row.indexOf('\t'),
                [mode, , blob] = row.slice(0, tab).split(' ');
              return { path: row.slice(tab + 1), mode: mode!, blob: blob! };
            }),
    );
  const plans = provenancePlan(data, view, states);
  invariant(plans, 'SOURCE_UNAVAILABLE', 'Candidate source is unavailable.');
  const selected =
    command.action === 'provenance' && command.file
      ? plans.filter(file => file.path === command.file)
      : plans;
  const files = paginate(selected);
  const read = async (blob: string) =>
    source ? source.object(blob) : workGit(store.root, ['cat-file', 'blob', blob], undefined, false, true);
  const items = await Promise.all(
    files.items.map(async file => {
      const result = await readFileProvenance(
        file,
        read,
        command.action === 'provenance' && command.lines,
        blob =>
          source
            ? lstatSync(join(source.directory, blob)).size
            : Number(workGit(store.root, ['cat-file', '-s', blob]).trim()),
      );
      if (command.action === 'view')
        return {
          path: result.path,
          status: result.status,
          additions: result.additions,
          deletions: result.deletions,
        };
      return {
        ...result,
        why: [...new Set([...model.whyIntentIds, ...file.contributors.map(c => c.intentId)])].map(
          intentId => ({
            intentId,
            outcome: data.intents.find(intent => intent.id === intentId)?.outcome ?? null,
            notes: whyNotes(data, intentId, file.path),
          }),
        ),
      };
    }),
  );
  return {
    revision: data.revision,
    result: {
      ...model,
      files: {
        ...files,
        items,
        ...(view.status === 'conflict'
          ? { unavailable: 'Conflicted Candidate has no composed file version.' }
          : {}),
      },
      ...(command.action === 'view' ? { runs: data.runs.filter(run => run.viewId === view.id) } : {}),
    },
  };
}
