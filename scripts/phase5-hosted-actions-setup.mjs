// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { coordinationClient } from '../dist/coordination-client.js';
import { ConvexExchange } from '../dist/exchange-client.js';
import { WorkStore } from '../dist/work-store.js';
import { hostProject } from '../dist/host-cli.js';
import { boundCutoverPins, cutoverBoundProject } from '../dist/source-cutover-client.js';
import { prepareDrillOwner } from './phase5-hosted-lifecycle-fixture.mjs';
import {
  dogfoodProject,
  drillDeployment,
  preflightHostedMachineDrill,
} from './phase5-hosted-lifecycle-drill.mjs';
import { readJson, writeJson } from './phase5-hosted-actions-context.mjs';

/** Explicit opt-in only. One tiny new project, original hosting/cutover journals
 * retained across unknown replies, no GitHub writes or authorization automation. */
export async function setupActionsDrill(directory) {
  directory = resolve(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'report.json');
  const report = existsSync(path)
    ? readJson(path)
    : {
        estimate: { total: 1900, client: 1200, serverInternalAllowance: 700 },
        calls: [],
        steps: [],
        createdAt: new Date().toISOString(),
        cleanup: 'not-created',
      };
  if (report.authority) return report;
  const save = () => writeJson(path, report);
  save();
  const base = coordinationClient(drillDeployment);
  const client = Object.fromEntries(
    ['query', 'mutation', 'action'].map(kind => [
      kind,
      async (ref, args) => {
        assert.notEqual(args.projectId, dogfoodProject);
        assert(report.calls.length + 700 + 180 < 2000, 'Q4 setup stop budget');
        report.calls.push({ kind, name: getFunctionName(ref), at: new Date().toISOString() });
        save();
        return base[kind](ref, args);
      },
    ]),
  );
  const exchange = (projectId, operationId = randomUUID()) => {
    const result = new ConvexExchange(drillDeployment, undefined, projectId, operationId, null);
    result.client = client;
    return result;
  };
  const owner = join(directory, 'seed-owner');
  await preflightHostedMachineDrill(client);
  if (!existsSync(owner)) await prepareDrillOwner(owner);
  report.project ??= await hostProject(
    owner,
    {
      deployment: drillDeployment,
      name: `Q4 Actions lifecycle ${report.createdAt}`,
      visibility: 'private',
      deferBackfill: true,
    },
    { client, exchange },
  );
  report.cleanup = 'pending';
  save();
  const store = new WorkStore(owner);
  report.cutover ??= {
    operationId: randomUUID(),
    mode: 'server',
    pins: await boundCutoverPins(store, client),
  };
  save();
  await cutoverBoundProject(store, report.cutover, true, client);
  report.authority = await cutoverBoundProject(store, report.cutover, false, client);
  report.steps.push({ name: 'create, seed and cut over new private scratch project', status: 'passed' });
  save();
  return report;
}
