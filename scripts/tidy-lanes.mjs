// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// One command to tidy leftover Lanes (friction fc3fcc3a): lists the open Lanes by what they hold, then
// completes the ones already merged to main and abandons the dormant ones, in bulk.
//
//   node scripts/tidy-lanes.mjs [--root ROOT] [--apply]
//
// Without --apply it only reads (lanes list and the abandon-dormant dry run). With --apply it runs
// `x complete-merged`, then `x abandon-dormant apply:true` until nothing abandonable is left. Both actions
// skip pinned Lanes and abandon nothing that is not dormant; abandon keeps the Lane's saves.
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { childEnv } from './child-env.mjs';

const MAX_PAGES = 10;
const MAX_ROUNDS = 20;

function realNforge(root, verb, action, command) {
  const args = verb === 'x' ? ['x', root, action] : ['agent', root, action];
  const run = spawnSync('nforge', [...args, JSON.stringify(command)], {
    env: childEnv({ allow: ['FORGE_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME'] }),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = String(run.stdout);
  const reply = JSON.parse(out.slice(out.lastIndexOf('\n{') + 1 || out.indexOf('{')));
  if (reply.error)
    throw new Error(`${action}: ${reply.error.code} ${String(reply.error.message).slice(0, 200)}`);
  return reply.result;
}

/** One line per open Lane: id, state, whether it landed, last activity, goal. */
export function laneLine(lane) {
  const landing = lane.landing
    ? `landing ${lane.landing.state ?? lane.landing.receiptId?.slice(0, 8) ?? 'yes'}`
    : 'no landing';
  return `${String(lane.laneId).slice(0, 8)}  ${lane.state}  ${landing}  ${String(lane.lastActivityAt ?? '').slice(0, 16)}  ${String(lane.intent ?? '').slice(0, 70)}`;
}

export function tidyLanes(argv, nforge = realNforge, out = console.log) {
  const root = resolve(argv.includes('--root') ? argv[argv.indexOf('--root') + 1] : '.');
  const apply = argv.includes('--apply');
  const lanes = [];
  let cursor;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = nforge(root, 'agent', 'lanes', { limit: 50, ...(cursor ? { cursor } : {}) });
    lanes.push(...(result.page ?? []));
    cursor = result.isDone ? undefined : result.continueCursor;
    if (!cursor) break;
  }
  out(`${lanes.length}${cursor ? '+' : ''} open Lane${lanes.length === 1 ? '' : 's'}:`);
  for (const lane of lanes) out(`  ${laneLine(lane)}`);
  const dry = nforge(root, 'x', 'abandon-dormant', { limit: 25 });
  out(
    `Dormant: ${dry.dormant ?? 0}; abandonable in this batch: ${dry.abandonable?.length ?? 0} (25 per call); kept: ${dry.kept?.length ?? 0}. ${dry.next ?? ''}`,
  );
  for (const lane of dry.abandonable ?? []) out(`  abandon ${JSON.stringify(lane)}`);
  for (const lane of dry.kept ?? []) out(`  keep ${JSON.stringify(lane)}`);
  if (!apply) {
    out(
      'Dry run. --apply completes every merged Lane and abandons every abandonable dormant Lane (all batches, not only the one above); saved heads are kept and start --reopen brings one back.',
    );
    return { completed: 0, abandoned: 0 };
  }
  const merged = nforge(root, 'x', 'complete-merged', {});
  out(`Completed ${merged.completed?.length ?? 0} merged Lane${merged.completed?.length === 1 ? '' : 's'}.`);
  let abandoned = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const done = nforge(root, 'x', 'abandon-dormant', { apply: true, limit: 25 });
    const count = done.abandoned?.length ?? 0;
    abandoned += count;
    if (!count) break;
  }
  out(`Abandoned ${abandoned} dormant Lane${abandoned === 1 ? '' : 's'} (their saves are kept).`);
  return { completed: merged.completed?.length ?? 0, abandoned };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    tidyLanes(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
