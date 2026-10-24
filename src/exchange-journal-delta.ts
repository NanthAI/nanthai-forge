// SPDX-License-Identifier: Apache-2.0
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { journalPageSchema, type JournalPage } from './work-journal-page.js';
import { retainedExchangeBase } from './exchange-receive-cache.js';
import { applyHostedEvent, parseWorkBytes, workDigest } from './work-metadata.js';
import { migrateHostedIntents } from './work-hosted-intents.js';
import type { WorkStore } from './work-store.js';
import type { ConvexExchange } from './exchange-client.js';

export async function exchangeJournalDelta(
  store: WorkStore,
  transport: ConvexExchange,
  backupId: string,
  progress?: (detail: string) => void,
  options: { reuseReceived?: boolean } = {},
) {
  const first = journalPageSchema.parse(await transport.journalPage()),
    header = first.header;
  invariant(header.backupId === backupId, 'WORK_STALE', 'Hosted source changed before journal paging.');
  const retained = retainedExchangeBase(store.directory, header.manifestSha256);
  invariant(retained, 'INVALID_WORK_JOURNAL', 'No retained Work matches the hosted manifest digest.');
  let data = parseWorkBytes(retained.work);
  invariant(
    data.revision === header.initialRevision && data.nativeHead === header.head,
    'INVALID_WORK_JOURNAL',
    'Retained Work revision or source differs from the hosted base.',
  );
  const events = (options.reuseReceived === false ? [] : store.load().hostedEvents).filter(
    event =>
      event.projectKey === header.projectKey &&
      event.archiveSha256 === header.archiveSha256 &&
      event.previousRevision >= header.initialRevision,
  );
  // Authenticate/replay the received prefix against its original exact base.
  for (const event of events) {
    data = migrateHostedIntents(data, header.intentMigration);
    applyHostedEvent(data, event);
  }
  let revision = data.revision,
    previous = events.at(-1);
  while (true) {
    const page: JournalPage = journalPageSchema.parse(await transport.journalPage(revision, first.snapshot));
    invariant(
      page.snapshot === first.snapshot &&
        JSON.stringify(page.header) === JSON.stringify(header) &&
        page.previousEventSha256 === (previous ? digest(JSON.stringify(previous)) : null),
      'INVALID_WORK_JOURNAL',
      'Hosted journal previous-event hash differs from the received prefix.',
    );
    for (const event of page.events) {
      invariant(
        event.projectKey === header.projectKey && event.archiveSha256 === header.archiveSha256,
        'INVALID_WORK_JOURNAL',
        'Hosted event differs from the selected project/checkpoint.',
      );
      data = migrateHostedIntents(data, header.intentMigration);
      applyHostedEvent(data, event);
      events.push(event);
      previous = event;
    }
    invariant(
      data.revision === page.nextRevision && (page.isDone || page.nextRevision > revision),
      'INVALID_WORK_JOURNAL',
      'Hosted journal page did not advance contiguously.',
    );
    revision = page.nextRevision;
    progress?.(`journal delta received through revision ${revision}/${header.revision}`);
    if (page.isDone) break;
  }
  data = migrateHostedIntents(data, header.intentMigration);
  invariant(revision === header.revision, 'INVALID_WORK_JOURNAL', 'Hosted journal coverage is incomplete.');
  // Retain the existing companion protocol and all its validation/CAS checks.
  const journal = JSON.stringify({
    schema: 1,
    kind: 'forge-hosted-work-journal',
    projectKey: header.projectKey,
    name: header.name,
    base: {
      archiveSha256: header.archiveSha256,
      manifestSha256: header.manifestSha256,
      workSha256: retained.pin.sha256,
    },
    events,
    revision,
    workSha256: workDigest(data),
    ...(header.intentMigration ? { intentMigration: header.intentMigration } : {}),
    coverage: 'Paged hosted operations over the exact retained private checkpoint.',
  });
  return {
    original: {
      json: retained.manifestBytes.toString('utf8'),
      digest: header.manifestSha256,
      sourceDigest: header.archiveSha256,
    },
    work: retained.work,
    journal,
    parsed: JSON.parse(journal),
  };
}
