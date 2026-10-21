// SPDX-License-Identifier: Apache-2.0
import {
  convertHostedIntents,
  migrateHostedIntents,
  type HostedIntentMigration,
} from './work-hosted-intents.js';
import { noteConversation } from './work-intent-local.js';
import type { UnifiedIntent } from './work-unified-types.js';
import { NativeClosureValidation } from './native-closure-validation.js';
import { validateExchangeCompanion } from './native-exchange-reconcile.js';
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { join, basename, dirname } from 'node:path';
import { digest } from './hash.js';
import { ForgeError, invariant } from './errors.js';
import { readSource } from './files.js';
import { WorkStore } from './work-store.js';
import { withWorkArchive } from './work-backup-archive.js';
import { overlayHostedJournal } from './work-backup.js';
import { restoreNativeWork } from './native-backup.js';
import { NativeSource } from './native-source.js';
import { applyHostedEvent, hostedJournalSchema, parseWorkBytes, validateWorkSize } from './work-metadata.js';
import {
  companionCommandSchema,
  type CompanionCommand,
  type CompanionConflict,
  type CompanionReceipt,
} from './native-companion-types.js';
import type { WorkData } from './work-types.js';

const equal = isDeepStrictEqual;
const prefix = <T>(a: T[], b: T[]) =>
  a.length <= b.length && a.every((value, index) => equal(value, b[index]));
const request = (c: CompanionCommand) =>
  digest(
    JSON.stringify({
      action: c.action,
      ...(c.preserveLocalSource ? { preserveLocalSource: true } : {}),
      ...(c.manifestSha256 ? { manifestSha256: c.manifestSha256 } : {}),
      projectKey: c.projectKey,
      archiveSha256: c.archiveSha256,
      journalSha256: c.journalSha256,
    }),
  );
// Read the pointer under the owner lock; materialize its immutable records outside it.
function localSnapshot(store: WorkStore, pointer: Buffer | null) {
  const bytes = store.pinnedBytes(pointer);
  invariant(bytes, 'INVALID_WORK_STORE', 'Original native Work metadata is unavailable.');
  return { data: parseWorkBytes(bytes), sha256: digest(bytes), pointer };
}
const samePointer = (a: Buffer | null, b: Buffer | null) => (a && b ? a.equals(b) : a === b);
function retry(data: WorkData, c: CompanionCommand) {
  const receipt = data.nativeCompanionReceipts?.find(item => item.id === c.operationId);
  if (receipt)
    invariant(
      receipt.request === request(c),
      'WORK_OPERATION_CHANGED',
      'Reconcile this operation with its original project, archive and journal digest pins.',
    );
  return receipt
    ? { revision: data.revision, result: { status: 'reconciled' as const, receipt } }
    : undefined;
}

// Only supported hosted metadata deltas are merged. Local source, evidence and
// every other collection remain owned by their current local owners.
export function mergeCompanion(
  base: WorkData,
  local: WorkData,
  hosted: WorkData,
  preserveLocalSource = false,
  intentMigration?: HostedIntentMigration,
) {
  const conflicts: CompanionConflict[] = [];
  const conflict = (collection: string, field: string, b: unknown, l: unknown, h: unknown, id?: string) =>
    conflicts.push({ collection, ...(id ? { id } : {}), field, base: b, local: l, hosted: h });
  if (!preserveLocalSource && base.nativeHead !== local.nativeHead)
    conflict('source', 'nativeHead', base.nativeHead, local.nativeHead, hosted.nativeHead);
  if (!prefix(base.hostedEvents, local.hostedEvents) || !prefix(local.hostedEvents, hosted.hostedEvents)) {
    conflict('hostedEvents', 'original-prefix', base.hostedEvents, local.hostedEvents, hosted.hostedEvents);
    return { conflicts };
  }
  // Already received original events form the semantic common base. Replaying
  // them here never touches the current local owner or its changed revision.
  let common = structuredClone(base);
  for (const event of hosted.hostedEvents.slice(base.hostedEvents.length, local.hostedEvents.length)) {
    common = migrateHostedIntents(common, intentMigration);
    applyHostedEvent(common, event);
  }
  common = migrateHostedIntents(common, intentMigration);
  // Authenticate original journal bytes before normalizing merge representations.
  // A pre-cutover source return pins legacy Work, even when the local owner is unified.
  if ([common, local, hosted].some(data => [16, 18, 20].includes(data.schema))) {
    const unified = (data: WorkData): WorkData =>
      [16, 18, 20].includes(data.schema) ? data : convertHostedIntents(data);
    common = unified(common);
    local = unified(local);
    hosted = unified(hosted);
  }
  if (!equal(common.hostedChannelMoves ?? [], local.hostedChannelMoves ?? []))
    conflict(
      'hostedChannelMoves',
      'original-receipts',
      common.hostedChannelMoves ?? [],
      local.hostedChannelMoves ?? [],
      hosted.hostedChannelMoves ?? [],
    );
  const merged = structuredClone(local);
  // A remote record can introduce fields whose reader version exceeds this
  // owner's original snapshot (for example completed lifecycle history).
  merged.schema = Math.max(local.schema, hosted.schema) as WorkData['schema'];
  // Preserve Array.find's first-match behavior, including legacy duplicate IDs.
  const originals = new Map<string, WorkData['intents'][number]>(),
    currents = new Map<string, WorkData['intents'][number]>();
  for (const intent of common.intents) if (!originals.has(intent.id)) originals.set(intent.id, intent);
  for (const intent of merged.intents) if (!currents.has(intent.id)) currents.set(intent.id, intent);
  for (const remote of hosted.intents) {
    const original = originals.get(remote.id);
    const current = currents.get(remote.id);
    if (!original) {
      if (!current) {
        const added = structuredClone(remote);
        merged.intents.push(added);
        currents.set(added.id, added);
      } else if (!equal(current, remote))
        conflict('intents', 'identity', undefined, current, remote, remote.id);
      continue;
    }
    if (!current) {
      conflict('intents', 'identity', original, undefined, remote, remote.id);
      continue;
    }
    if ([16, 18, 20].includes(merged.schema)) {
      const before = original as Record<string, unknown>,
        currentFields = current as Record<string, unknown>,
        remoteFields = remote as Record<string, unknown>;
      for (const field of [
        'title',
        'outcome',
        'description',
        'version',
        'previousVersion',
        'operationId',
        'request',
        'updatedAt',
        'creatorAccountId',
        'assigneeAccountIds',
        'provenance',
        'memberships',
        'relatedIntentIds',
        'historyRefs',
      ]) {
        if (equal(before[field], remoteFields[field])) continue;
        if (!equal(before[field], currentFields[field]) && !equal(currentFields[field], remoteFields[field]))
          conflict('intents', field, before[field], currentFields[field], remoteFields[field], remote.id);
        else currentFields[field] = structuredClone(remoteFields[field]);
      }
    }
    for (const field of ['outcome', 'constraints', 'base', 'createdAt', 'baseChannel', 'hostedBase'] as const)
      if (
        (field !== 'outcome' || ![16, 18, 20].includes(merged.schema)) &&
        (!equal(original[field], current[field]) || !equal(original[field], remote[field]))
      )
        conflict('intents', field, original[field], current[field], remote[field], remote.id);
    if (
      remote.status !== original.status &&
      current.status !== original.status &&
      current.status !== remote.status
    )
      conflict('intents', 'status', original.status, current.status, remote.status, remote.id);
    else if (remote.status !== original.status) current.status = remote.status;
    type LifecycleIntent = typeof current & { lifecycle?: { from: string; to: string; at: string }[] };
    const originalLifecycle = (original as LifecycleIntent).lifecycle ?? [],
      localLifecycle = (current as LifecycleIntent).lifecycle ?? [],
      remoteLifecycle = (remote as LifecycleIntent).lifecycle ?? [];
    if (!prefix(originalLifecycle, localLifecycle) || !prefix(originalLifecycle, remoteLifecycle))
      conflict('intents', 'lifecycle', originalLifecycle, localLifecycle, remoteLifecycle, remote.id);
    else if (originalLifecycle.length || localLifecycle.length || remoteLifecycle.length)
      (current as LifecycleIntent).lifecycle = [
        ...structuredClone(remoteLifecycle),
        ...structuredClone(
          localLifecycle
            .slice(originalLifecycle.length)
            .filter(item => !remoteLifecycle.some(remote => equal(remote, item))),
        ),
      ];
    if (!prefix(original.notes, current.notes) || !prefix(original.notes, remote.notes))
      conflict('intents', 'notes', original.notes, current.notes, remote.notes, remote.id);
    else {
      current.notes = [...structuredClone(remote.notes), ...current.notes.slice(original.notes.length)];
      if ([16, 18, 20].includes(merged.schema)) {
        const before = original as unknown as UnifiedIntent,
          localIntent = current as unknown as UnifiedIntent,
          remoteIntent = remote as unknown as UnifiedIntent;
        if (
          !prefix(before.conversation, localIntent.conversation) ||
          !prefix(before.conversation, remoteIntent.conversation)
        )
          conflict(
            'intents',
            'conversation',
            before.conversation,
            localIntent.conversation,
            remoteIntent.conversation,
            remote.id,
          );
        else {
          const additions = localIntent.conversation
            .slice(before.conversation.length)
            .map(entry =>
              entry.kind === 'note'
                ? noteConversation(remote.id, entry.index + remote.notes.length - original.notes.length)
                : entry,
            );
          localIntent.conversation = [
            ...structuredClone(remoteIntent.conversation),
            ...structuredClone(
              additions.filter(
                entry => !remoteIntent.conversation.some(remoteEntry => remoteEntry.id === entry.id),
              ),
            ),
          ];
        }
      }
    }
  }
  // Planning versions and comments are original append-only observations. A
  // competing version of the same item is a conflict, never a silent overwrite.
  const planning = <T extends { id: string }>(
    collection: string,
    original: T[],
    current: T[],
    remote: T[],
    key: (record: T) => string,
  ) => {
    if (!prefix(original, current) || !prefix(original, remote)) {
      conflict(collection, 'original-prefix', original, current, remote);
      return current;
    }
    const records = new Map(remote.map(record => [key(record), record])),
      additions: T[] = [];
    for (const record of current.slice(original.length)) {
      const retained = records.get(key(record));
      if (retained && !equal(retained, record))
        conflict(collection, 'original-version', undefined, record, retained, record.id);
      else if (!retained) additions.push(record);
    }
    return structuredClone([...remote, ...additions]);
  };
  merged.planningItems = planning(
    'planningItems',
    common.planningItems,
    local.planningItems,
    hosted.planningItems,
    record => `${record.id}:${record.version}`,
  );
  merged.planningComments = planning(
    'planningComments',
    common.planningComments,
    local.planningComments,
    hosted.planningComments,
    record => record.id,
  );
  if ([16, 18, 20].includes(merged.schema)) {
    const before = common as Record<string, unknown>,
      current = merged as Record<string, unknown>,
      remote = hosted as Record<string, unknown>;
    for (const field of ['initiatives', 'intentAliases']) {
      if (equal(before[field], remote[field])) continue;
      if (!equal(before[field], current[field]) && !equal(current[field], remote[field]))
        conflict(field, 'original-version', before[field], current[field], remote[field]);
      else current[field] = structuredClone(remote[field]);
    }
  }
  merged.hostedEvents = structuredClone(hosted.hostedEvents);
  if (hosted.hostedChannelMoves) merged.hostedChannelMoves = structuredClone(hosted.hostedChannelMoves);
  return { conflicts, merged };
}

/** followLocal (bound push): expectedRevision is a floor. Later local writes are merged
 * with the same validated hosted metadata under the final short owner lock. */
export async function reconcileHostedWork(
  store: WorkStore,
  input: unknown,
  expectedRevision: number,
  options: { followLocal?: boolean; candidate?: WorkData; onCandidate?: (data: WorkData) => void } = {},
) {
  const parsed = companionCommandSchema.safeParse(input);
  invariant(
    parsed.success && Number.isSafeInteger(expectedRevision) && expectedRevision >= 0,
    'BAD_ARGUMENT',
    'Select original native archive/journal paths, digest pins, project and operation identity.',
  );
  invariant(
    store.native,
    'UNSUPPORTED_NATIVE_WORK',
    'Hosted companion reconciliation uses the native Work owner.',
  );
  const command = parsed.data;
  const first = (() => {
    const snapshot = localSnapshot(
        store,
        store.locked(() => store.pointer()),
      ),
      existing = retry(snapshot.data, command);
    if (existing) return { existing, snapshot };
    if (options.followLocal)
      invariant(
        snapshot.data.revision >= expectedRevision,
        'WORK_OPERATION_CHANGED',
        'Local Work moved behind the pinned push revision. Existing source and Work remain available.',
      );
    else
      invariant(
        snapshot.data.revision === expectedRevision,
        'WORK_STALE',
        'Work changed. Existing source and Work remain available.',
      );
    return { snapshot };
  })();
  if (first.existing && !options.candidate) return first.existing;
  const snapshot = first.snapshot!;
  const scratch = mkdtempSync(join(tmpdir(), 'forge-native-companion-'));
  try {
    const bytes = readSource(
      realpathSync(dirname(command.journalPath)),
      basename(command.journalPath),
      Number.MAX_SAFE_INTEGER,
    );
    invariant(
      bytes && digest(bytes) === command.journalSha256,
      'INVALID_WORK_JOURNAL',
      'Original hosted journal differs from its selected digest.',
    );
    const journal = (() => {
      try {
        return hostedJournalSchema.parse(JSON.parse(bytes.toString('utf8')));
      } catch {
        invariant(false, 'INVALID_WORK_JOURNAL', 'Original hosted journal metadata is invalid.');
      }
    })();
    invariant(
      journal.projectKey === command.projectKey,
      'INVALID_WORK_JOURNAL',
      'Original hosted journal differs from its selected project.',
    );
    const journalPath = join(scratch, 'journal.json');
    writeFileSync(journalPath, bytes, { mode: 0o600, flag: 'wx' });
    const validated =
      command.transport === 'objects'
        ? validateExchangeCompanion(store, command, scratch, journalPath)
        : await withWorkArchive(command.archivePath, async (directory, archive) => {
            invariant(
              archive.sha256 === command.archiveSha256,
              'INVALID_WORK_BACKUP',
              'Original common archive differs from its selected digest.',
            );
            const base = parseWorkBytes(readFileSync(join(directory, 'work.json')));
            invariant(base.nativeHead, 'INVALID_WORK_BACKUP', 'Select an original native common archive.');
            overlayHostedJournal(directory, archive.sha256, journalPath);
            // Retain exact replayed metadata before recovery marks scratch runs
            // interrupted. Full native restore validates source and evidence closure.
            const hosted = parseWorkBytes(readFileSync(join(directory, 'work.json')));
            mkdirSync(join(scratch, 'validation'), { mode: 0o700 });
            await restoreNativeWork(directory, join(scratch, 'validation', 'owner'));
            return { base, hosted };
          });
    const candidate = options.candidate
      ? mergeCompanion(
          validated.base,
          options.candidate,
          validated.hosted,
          command.preserveLocalSource,
          journal.intentMigration,
        )
      : undefined;
    if (candidate?.conflicts.length)
      return {
        revision: snapshot.data.revision,
        result: { status: 'conflict' as const, conflicts: candidate.conflicts },
      };
    let result = mergeCompanion(
      validated.base,
      snapshot.data,
      validated.hosted,
      command.preserveLocalSource,
      journal.intentMigration,
    );
    const publication = store.locked(() => {
      const pointer = store.pointer(),
        current = samePointer(pointer, snapshot.pointer) ? snapshot : localSnapshot(store, pointer),
        existing = retry(current.data, command);
      if (existing) return existing;
      const moved = current.data.revision !== snapshot.data.revision || current.sha256 !== snapshot.sha256;
      invariant(
        !moved || options.followLocal,
        'WORK_STALE',
        'Work changed during companion validation. Existing source and Work remain available.',
      );
      // The hosted side is already validated; merging is in-memory and reruns
      // against the newer local snapshot rather than failing the push.
      if (moved)
        result = mergeCompanion(
          validated.base,
          current.data,
          validated.hosted,
          command.preserveLocalSource,
          journal.intentMigration,
        );
      // No source objects are imported. Pin registration and existing collection
      // serialize on this owner lock, so retained source cannot vanish between
      // validation and its new Intent/receipt reference.
      const source = new NativeClosureValidation(new NativeSource(store.root));
      for (const head of new Set([
        ...validated.hosted.intents.flatMap(item => (item.base ? [item.base] : [])),
        ...(validated.hosted.hostedChannelMoves ?? []).map(item => item.head),
      ])) {
        try {
          source.validate(head);
        } catch (error) {
          if (!(error instanceof ForgeError)) throw error;
          result.conflicts.push({ collection: 'source', field: 'retainedState', hosted: head });
        }
      }
      if (result.conflicts.length)
        return {
          revision: current.data.revision,
          result: { status: 'conflict' as const, conflicts: result.conflicts },
        };
      const data = result.merged!;
      if (data.schema < 3) data.schema = 3;
      data.revision = Math.max(current.data.revision, validated.hosted.revision) + 1;
      const receipt: CompanionReceipt = {
        id: command.operationId,
        request: request(command),
        projectKey: command.projectKey,
        at: new Date().toISOString(),
        archiveSha256: command.archiveSha256,
        journalSha256: command.journalSha256,
        baseWorkSha256: journal.base.workSha256,
        hostedWorkSha256: journal.workSha256,
        previousRevision: current.data.revision,
        previousWorkSha256: current.sha256,
        revision: data.revision,
        hostedRevision: validated.hosted.revision,
        eventIds: validated.hosted.hostedEvents
          .slice(current.data.hostedEvents.length)
          .map(event => event.id),
      };
      data.nativeCompanionReceipts = [...(data.nativeCompanionReceipts ?? []), receipt];
      validateWorkSize(data);
      store.save(data);
      return { revision: data.revision, result: { status: 'reconciled' as const, receipt } };
    });
    if (candidate?.merged && publication.result.status === 'reconciled') {
      const data = candidate.merged;
      data.schema = Math.max(data.schema, 3) as WorkData['schema'];
      data.revision = publication.result.receipt.revision;
      if (!(data.nativeCompanionReceipts ?? []).some(item => item.id === command.operationId))
        (data.nativeCompanionReceipts ??= []).push(publication.result.receipt);
      validateWorkSize(data);
      options.onCandidate?.(data);
    }
    return publication;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
