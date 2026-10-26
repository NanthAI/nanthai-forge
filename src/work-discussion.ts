// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { readSource } from './files.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { readPull } from './work-import.js';
import { workGithubApi } from './work-github.js';
import {
  discussionRecordSchema,
  type DiscussionCommand,
  type DiscussionRecord,
  type WorkData,
} from './work-types.js';
import type { WorkStore } from './work-store.js';

// Preserve all provider fields; deleted users and draft reviews can have missing context.
const entry = z
  .object({
    id: z.number().int().positive().safe(),
    body: z.string().nullable().optional(),
    user: z
      .object({ id: z.number().int().positive().safe(), login: z.string() })
      .passthrough()
      .nullable()
      .optional(),
    html_url: z.string().nullable().optional(),
  })
  .passthrough();
const pageSchema = z.object({ record: discussionRecordSchema, items: z.array(entry) });
export type DiscussionPage = z.infer<typeof pageSchema>;
const filename = (id: string) => `discussion-${id}.json`;
function read(store: WorkStore, id: string): DiscussionPage | null {
  const bytes = readSource(store.directory, filename(id), 8 * 1024 * 1024);
  if (!bytes) return null;
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    /* Structured invalid-receipt error below. */
  }
  const parsed = pageSchema.safeParse(value);
  invariant(
    parsed.success &&
      parsed.data.record.id === id &&
      parsed.data.record.count === parsed.data.items.length &&
      parsed.data.record.digest === digest(JSON.stringify(parsed.data.items)),
    'INVALID_DISCUSSION',
    'The retained discussion page is invalid. Existing observations are preserved.',
  );
  return parsed.data;
}
function mapped(data: WorkData, target: DiscussionRecord['target']) {
  if (target.kind === 'intent') {
    const pr = data.intents.find(i => i.id === target.id)?.external;
    invariant(pr, 'NOT_FOUND', 'Choose an imported PR Intent.');
    return { repository: pr.repository, number: pr.number, head: pr.observations.at(-1)!.head };
  }
  const pr = data.publications.find(p => p.id === target.id);
  invariant(pr?.number, 'NOT_FOUND', 'Choose a published PR mapping.');
  return { repository: pr.repository, number: pr.number, head: pr.head };
}
export async function discussionWork(store: WorkStore, command: DiscussionCommand, revision: number) {
  invariant(Number.isSafeInteger(revision) && revision >= 0, 'BAD_ARGUMENT', 'Send a valid work revision.');
  if (command.action !== 'import-discussion')
    return store.locked(() => {
      const data = store.load(),
        record = data.githubDiscussions.find(r => r.id === command.id),
        page = record ? read(store, record.id) : null;
      invariant(
        record && page && JSON.stringify(record) === JSON.stringify(page.record),
        'NOT_FOUND',
        'This recorded discussion page is unavailable.',
      );
      return { revision: data.revision, result: page };
    });
  const same = (page: DiscussionPage) => {
    invariant(
      page.record.target.kind === command.target.kind &&
        page.record.target.id === command.target.id &&
        page.record.feed === command.feed &&
        page.record.page === command.page,
      'EVIDENCE_CHANGED',
      'This discussion operation names another page. Its original observation is retained.',
    );
    return page;
  };
  const retain = (data: WorkData, page: DiscussionPage) => {
    const existing = data.githubDiscussions.find(r => r.id === page.record.id);
    invariant(
      !existing || JSON.stringify(existing) === JSON.stringify(page.record),
      'INVALID_DISCUSSION',
      'Discussion metadata and its receipt differ. Both are preserved.',
    );
    if (!existing) {
      data.githubDiscussions.push(page.record);
      data.revision++;
      store.save(data);
    }
    return { revision: data.revision, result: page.record };
  };
  const start = store.locked(() => {
    const data = store.load(),
      receipt = read(store, command.operationId);
    if (receipt) return { existing: retain(data, same(receipt)) };
    invariant(
      !data.githubDiscussions.some(r => r.id === command.operationId),
      'INVALID_DISCUSSION',
      'The original discussion receipt is unavailable; its observation is preserved.',
    );
    invariant(
      data.revision === revision,
      'WORK_STALE',
      'Work changed. Refresh before reading a new discussion page.',
    );
    return { source: mapped(data, command.target) };
  });
  if (start.existing) return start.existing;
  const source = start.source!,
    pull = await readPull(store, source.repository, source.number);
  const endpoint =
    command.feed === 'conversation'
      ? `issues/${source.number}/comments`
      : `pulls/${source.number}/${command.feed === 'reviews' ? 'reviews' : 'comments'}`;
  const parsed = z
    .array(entry)
    .safeParse(
      await workGithubApi(store, `repos/${source.repository}/${endpoint}?per_page=100&page=${command.page}`),
    );
  invariant(
    parsed.success,
    'INVALID_DISCUSSION',
    'GitHub returned an invalid discussion page. Previous observations are retained.',
  );
  const page: DiscussionPage = {
    record: {
      ...source,
      id: command.operationId,
      target: command.target,
      providerHead: pull.head.sha,
      feed: command.feed,
      page: command.page,
      at: new Date().toISOString(),
      count: parsed.data.length,
      more: parsed.data.length === 100,
      digest: digest(JSON.stringify(parsed.data)),
    },
    items: parsed.data,
  };
  return store.locked(() => {
    const data = store.load(),
      receipt = read(store, command.operationId);
    if (receipt) return retain(data, same(receipt));
    const current = mapped(data, command.target);
    invariant(
      current.repository === source.repository && current.number === source.number,
      'EVIDENCE_CHANGED',
      'The PR mapping changed during the read. Existing work is preserved.',
    );
    const temp = join(store.directory, `${randomUUID()}.tmp`),
      fd = openSync(temp, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify(page));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, join(store.directory, filename(command.operationId)));
    // Receipt precedes metadata: lost publication replies reconcile the original page without another source read.
    return retain(data, page);
  });
}
