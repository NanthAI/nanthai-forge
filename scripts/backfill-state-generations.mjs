// SPDX-License-Identifier: Apache-2.0
// Explicit dev-operator command, never scheduled or invoked by ordinary source work.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
const args = process.argv.slice(2),
  option = name => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args[i + 1];
  };
const deployment = option('--deployment'),
  projectId = option('--project'),
  actor = option('--actor'),
  file = option('--cursor');
const preview = !args.includes('--apply');
if (!deployment || !projectId || !actor || !file || args.includes('--prod'))
  throw Error(
    'Usage: node scripts/backfill-state-generations.mjs --deployment DEV_NAME --project PROJECT_ID --actor OWNER_ID --cursor PRIVATE_FILE [--apply]',
  );
let state = existsSync(file)
  ? JSON.parse(readFileSync(file, 'utf8'))
  : {
      deployment,
      projectId,
      actor,
      preview,
      operationId: randomUUID(),
      cursor: null,
      pending: [],
      done: false,
      totals: { pages: 0, states: 0, missing: 0, sourceBytes: 0, manifestBytes: 0, assigned: 0 },
    };
for (const key of ['deployment', 'projectId', 'actor', 'preview'])
  if (state[key] !== { deployment, projectId, actor, preview }[key])
    throw Error('Use a separate cursor for each project and preview/apply pass.');
const save = () => {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  renameSync(temporary, file);
};
const seen = new Set();
while (!state.done) {
  const key = createHash('sha256')
    .update(JSON.stringify([state.cursor, state.pending]))
    .digest('hex');
  if (seen.has(key))
    throw Error(
      'Generation dependencies did not advance; inspect retained source for a cycle. Cursor preserved.',
    );
  seen.add(key);
  save(); // An interrupted/unknown outcome replays the identical deterministic page.
  const call = spawnSync(
    'npx',
    [
      'convex',
      'run',
      '--deployment',
      deployment,
      'projectStateGenerationActions:step',
      JSON.stringify({
        projectId,
        actor,
        operationId: state.operationId,
        cursor: state.cursor,
        pending: state.pending,
        preview,
      }),
    ],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );
  if (call.status !== 0) {
    process.stderr.write(call.stderr);
    throw Error('Generation page failed; rerun the same command to resume.');
  }
  let result = JSON.parse(call.stdout.trim());
  if (typeof result === 'string') result = JSON.parse(result);
  state.cursor = result.cursor;
  state.pending = result.pending ?? [];
  state.done = result.done;
  state.totals.pages++;
  state.totals.states += result.states;
  state.totals.missing += result.missing ?? 0;
  state.totals.sourceBytes += result.sourceBytes;
  state.totals.manifestBytes += result.bytes ?? 0;
  state.totals.assigned += result.assigned ?? 0;
  save();
  console.log(JSON.stringify({ operationId: state.operationId, preview, done: state.done, ...state.totals }));
}
