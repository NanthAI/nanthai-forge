// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
export const cutover = await import(moduleUrl('../convex/projectSourceCutover.ts'));
export const discovery = await import(moduleUrl('../convex/projectHostedAgent.ts'));
export const legacy = await import(moduleUrl('../convex/projectWorkActions.ts'));
export async function cutoverFixture(f) {
  const transaction = f.rawChecks?.transaction ?? f.transaction ?? f.call;
  const native = { mode: 'native-owner', epoch: 0 };
  const main = { ...f.main, authority: native };
  Object.assign(f.main, main);
  f.patch('projectHostedChannels', f.mainId, { selection: canonicalPayload(main) });
  const backupId = f.insert('projectBackups', {
    projectId: f.projectId,
    status: 'stored',
    validatedClosure: 1,
    digest: 'a'.repeat(64),
    preview: { revision: 7, channels: [{ name: 'main', head: main.head }] },
  });
  f.patch('hostedProjects', f.projectId, {
    key: randomUUID(),
    sourceAuthority: native,
    currentBackup: backupId,
    revision: 1,
  });
  const call = (name, fn, args, actor = 'owner') =>
    transaction(name, fn, { projectId: f.projectId, ...args }, actor);
  const pins = async () => JSON.parse(await call('cutoverCurrent', cutover.current, {}));
  const request = { operationId: randomUUID(), mode: 'server', pins: await pins() };
  const run = (fn, request_, actor) =>
    call('cutover', fn, { request: canonicalPayload(request_) }, actor).then(JSON.parse);
  return {
    ...f,
    cutoverCall: call,
    pins,
    cutoverRequest: request,
    dryRun: (r = request, actor) => run(cutover.dryRun, r, actor),
    applyCutover: (r = request, actor) => run(cutover.apply, r, actor),
  };
}
