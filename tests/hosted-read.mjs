// Test-only oracle: the full Work snapshot the removed `projectWorkActions.read`
// action used to return. Production reads go through the Work index instead.
import { moduleUrl } from './convex-module.mjs';
import { digest } from '../dist/hash.js';
import { archiveChannels } from '../dist/work-archive-metadata.js';
import { hostedChannels, workBytes } from '../dist/work-metadata.js';

const actions = await import(moduleUrl('../convex/projectWorkActions.ts')),
  { report } = await import(moduleUrl('../convex/errors.ts'));

export async function readHosted(ctx, input) {
  try {
    return await readSnapshot(ctx, input);
  } catch (error) {
    return report(error);
  }
}
async function readSnapshot(ctx, { projectId }) {
  const actor = await actions.caller(ctx),
    snapshot = await actions.load(ctx, projectId, actor),
    owner = snapshot.project.owner === actor,
    editable = [];
  if (!owner) {
    for await (const event of ctx.db
      .query('projectWorkEvents')
      .withIndex('by_project_and_revision', q => q.eq('projectId', projectId))) {
      if (JSON.parse(event.command).action === 'intent' && event.baseBackupId && event.actor === actor)
        editable.push(event.operationId);
    }
  }
  return JSON.stringify({
    projectId,
    name: snapshot.project.name,
    key: snapshot.project.key,
    backupId: snapshot.backup._id,
    backupDigest: snapshot.backup.digest,
    sourceTransport: snapshot.backup.transport,
    sourceHead: snapshot.manifest.head,
    sourceKind: snapshot.manifest.kind === 'forge-native-work-backup' ? 'native' : 'git',
    channels: archiveChannels(snapshot.manifest, snapshot.data),
    hostedChannels: hostedChannels(snapshot.data),
    data: snapshot.data,
    events: snapshot.data.hostedEvents,
    workDigest: digest(workBytes(snapshot.data)),
    actor,
    capabilities: {
      owner,
      editableIntentIds: owner ? snapshot.data.intents.map(item => item.id) : editable,
      intent: true,
      note: true,
      intentStatus: true,
      sourceReturn: owner,
      hostedChannels: owner,
      planning: owner,
      execution: 'local',
    },
  });
}
