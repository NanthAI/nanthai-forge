// SPDX-License-Identifier: Apache-2.0
// What a non-owner receives of a project row (Item 5ba7c7f9, docs/access.md#what-leaves-convex). The owner reads the
// whole row; every other viewer (a member, or a signed-in reader of a public project) gets an allowlist. The check
// compares the row the read already loaded with the caller, so it costs no Convex read. Emails and check credential
// references inside policy copies are removed for non-owners at the public boundary (convex/publicPeople.ts).
import type { Doc } from './_generated/dataModel';

type Project = Doc<'hostedProjects'>;

/** The fields the project screens and the CLI read from `projectWork.state`. A new field stays owner-only until
 * it is added here: policy, purge, retention, pending operations and storage internals never leave for others. */
const VIEWER_FIELDS = [
  '_id',
  '_creationTime',
  'owner',
  'key',
  'name',
  'slug',
  'visibility',
  'planVisibility',
  'currentBackup',
  'revision',
  'removal',
] as const satisfies readonly (keyof Project)[];
/** The empty-hosted-project marker (convex/projectBootstrapStore.ts) names only the project, which the viewer
 * already reads; the web uses it to open the project's first channel. Every other hosting request stays. */
const EMPTY_HOSTED = '["empty-hosted-project",';

export function projectForViewer(project: Project, viewer: string): Project {
  if (project.owner === viewer) return project;
  const view: Partial<Project> = {};
  for (const field of VIEWER_FIELDS)
    if (project[field] !== undefined) (view as Record<string, unknown>)[field] = project[field];
  // The Work pointer: the screens select the index by backup and revision; migration and generation ids stay.
  if (project.work) {
    const { backupId, operationId, initialRevision, revision } = project.work;
    view.work = { backupId, operationId, initialRevision, revision };
  }
  if (project.hostingRequest?.startsWith(EMPTY_HOSTED)) view.hostingRequest = project.hostingRequest;
  return view as Project;
}
