// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { invariant, ForgeError } from '../src/errors';
import { migrateHostedIntents } from '../src/work-hosted-intents';
import { digest } from '../src/hash';
import { hostedCommandSchema, type HostedEvent, type WorkData } from '../src/work-types';
import { applyHostedEvent, parseWorkBytes, validateWorkSize, validateParsedWork } from '../src/work-metadata';
import { resolveExchangeWork } from '../src/native-exchange-stream';
import { sourceManifestSchema } from '../src/work-archive-metadata';
import { exchangeObjectReader, type ExchangeObjectReader } from './projectExchangeReader';
import { exchangeMetadata } from './projectExchangeActions';
import { projectArchiveMetadata } from './projectArchiveMetadata';
import { publicationSnapshot } from './projectSourceReturnMetadata';
type SourceSnapshot = {
  backup: Doc<'projectBackups'>;
  project: Doc<'hostedProjects'>;
  manifest: ReturnType<typeof sourceManifestSchema.parse>;
  data: WorkData;
  originalWorkDigest: string;
  publication: Awaited<ReturnType<typeof publicationSnapshot>>;
};
export async function source(
  ctx: ActionCtx,
  backupId: Id<'projectBackups'>,
  owner: string,
  reader?: ExchangeObjectReader,
  metadata = false,
): Promise<SourceSnapshot> {
  const objectReader = reader ?? exchangeObjectReader(ctx, true);
  const original: { backup: Doc<'projectBackups'>; project: Doc<'hostedProjects'> } = await ctx.runQuery(
    internal.projectBackups.get,
    { id: backupId, owner },
  );
  invariant(
    original.backup.status === 'stored' &&
      (original.backup.transport === 'objects' || original.backup.storageId),
    'PROJECT_UNAVAILABLE',
    'Select a stored source and Work backup.',
  );
  // Only source return opts into owner publication metadata. Existing source
  // reads retain their current byte reader and access behavior.
  const publication = metadata ? await publicationSnapshot(ctx, original.backup, owner) : undefined;
  const streamed =
    original.backup.transport === 'objects' && !publication
      ? await resolveExchangeWork(
          (
            await objectReader.read(original.backup.projectId, owner, [
              {
                sha256: original.backup.objectManifest?.digest ?? original.backup.digest,
                size: original.backup.objectManifest?.size ?? original.backup.size,
              },
            ])
          )[0]!,
          pins => objectReader.read(original.backup.projectId, owner, pins),
        )
      : undefined;
  const bytes = streamed
    ? undefined
    : publication?.work !== undefined
      ? { manifest: Buffer.from(JSON.stringify(publication.manifest)), work: Buffer.from(publication.work) }
      : original.backup.transport === 'objects'
        ? await exchangeMetadata(ctx, original.backup, owner, objectReader)
        : await projectArchiveMetadata(
            ctx,
            original.backup.storageId!,
            original.backup.size,
            original.backup.digest,
            () => ctx.runQuery(internal.projectBackups.get, { id: backupId, owner }),
          );
  const manifestBytes = streamed?.manifest ?? bytes!.manifest,
    manifest = sourceManifestSchema.parse(JSON.parse(Buffer.from(manifestBytes).toString('utf8'))),
    file = manifest.files.find(item => item.path === 'work.json');
  invariant(
    digest(manifestBytes) === original.backup.preview.manifestDigest &&
      file &&
      (streamed || (digest(bytes!.work) === file.sha256 && bytes!.work.byteLength === file.size)),
    'INVALID_WORK_BACKUP',
    'Work or manifest bytes differ from the stored archive pins.',
  );
  const data = streamed ? validateParsedWork(streamed.data) : parseWorkBytes(bytes!.work);
  invariant(
    data.revision === manifest.revision &&
      (manifest.kind === 'forge-native-work-backup'
        ? data.nativeHead === manifest.head &&
          manifest.files.some(
            file => file.path === `objects/${manifest.head}` && file.sha256 === manifest.head,
          )
        : manifest.head.length === (manifest.format === 'sha1' ? 40 : 64) &&
          manifest.refs.every(pin => pin.head.length === manifest.head.length)),
    'INVALID_WORK_BACKUP',
    'Source format or Work revision differs from its manifest.',
  );
  await ctx.runQuery(internal.projectBackups.get, { id: backupId, owner });
  return { ...original, manifest, data, originalWorkDigest: file.sha256, publication };
}
const event = (projectKey: string, archiveSha256: string, item: Doc<'projectWorkEvents'>): HostedEvent => ({
  projectKey,
  archiveSha256,
  id: item.operationId,
  request: item.request,
  previousRevision: item.previousRevision,
  actor: item.actor,
  at: item.at,
  command: hostedCommandSchema.parse(JSON.parse(item.command)),
  ...(item.automatic ? { automatic: item.automatic } : {}),
});
export async function load(
  ctx: ActionCtx,
  projectId: Id<'hostedProjects'>,
  owner: string,
  reader?: ExchangeObjectReader,
  options: { requireCurrent?: boolean; metadata?: boolean } = {},
): Promise<SourceSnapshot & { events: HostedEvent[] }> {
  const project: Doc<'hostedProjects'> = await ctx.runQuery(internal.projectWork.get, { projectId, owner });
  invariant(project.work, 'PROJECT_WORK_MISSING', 'Start hosted Work from a stored source backup.');
  const unchanged = async () => {
    const current: Doc<'hostedProjects'> = await ctx.runQuery(internal.projectWork.get, { projectId, owner });
    return (
      current.work?.backupId === project.work!.backupId &&
      current.work?.revision === project.work!.revision &&
      current.work?.initialRevision === project.work!.initialRevision &&
      JSON.stringify(current.work?.intentMigration ?? null) ===
        JSON.stringify(project.work!.intentMigration ?? null)
    );
  };
  try {
    const snapshot = await source(ctx, project.work.backupId, owner, reader, options.metadata),
      events: HostedEvent[] = [];
    let cursor: string | null = null;
    invariant(
      snapshot.project._id === projectId && snapshot.data.revision === project.work.initialRevision,
      'INVALID_WORK_JOURNAL',
      'Hosted Work base differs from its source archive.',
    );
    // ponytail: replay the existing bounded Work journal; materialize snapshots if measured journal latency warrants it.
    while (true) {
      const page: { page: Doc<'projectWorkEvents'>[]; isDone: boolean; continueCursor: string } =
        await ctx.runQuery(internal.projectWork.events, {
          projectId,
          owner,
          initialRevision: project.work.initialRevision,
          revision: project.work.revision,
          paginationOpts: { cursor, numItems: 100, maximumBytesRead: 500000, maximumRowsRead: 100 },
        });
      for (const item of page.page) {
        const operation = event(project.key, snapshot.backup.digest, item);
        snapshot.data = migrateHostedIntents(snapshot.data, project.work.intentMigration);
        applyHostedEvent(snapshot.data, operation);
        events.push(operation);
      }
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    invariant(
      snapshot.data.revision === project.work.revision,
      'INVALID_WORK_JOURNAL',
      'Hosted Work operation coverage is incomplete.',
    );
    snapshot.data = migrateHostedIntents(snapshot.data, project.work.intentMigration);
    validateWorkSize(snapshot.data);
    const current = await unchanged();
    invariant(
      !options.requireCurrent || current,
      'WORK_CHANGED_DURING_PUSH',
      'Hosted Work changed while reading its checkpoint and journal. Retry the original operation to read a consistent snapshot.',
    );
    return { ...snapshot, project, events };
  } catch (error) {
    // Recheck authority before identifying a race; corruption under a stable
    // head remains the original validation failure. Never disguise access denial.
    if (!(await unchanged()))
      throw new ForgeError(
        'WORK_CHANGED_DURING_PUSH',
        'Hosted Work changed while reading its checkpoint and journal. Retry the original operation to read a consistent snapshot.',
      );
    throw error;
  }
}
