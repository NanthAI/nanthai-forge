// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { childEnv } from './child-env.mjs';
import { journalLock } from './convex-spend-journal.mjs';
import { isMainModule } from './main-module.mjs';

// Each of these product switches is enabled only by the literal on setting.
const switches = new Set([
  'FORGE_COMPACT_DISCARDED_CHECKS',
  'FORGE_INVITATION_EMAIL',
  'FORGE_JOURNAL_SEGMENTS',
  'FORGE_MEMBER_APPROVAL_REQUESTS',
  'FORGE_MIGRATION_LEDGER',
  'FORGE_PHYSICAL_MANIFESTS',
  'FORGE_PLANNING_IMPORTS',
  'FORGE_PUBLIC_SNAPSHOTS',
  'FORGE_QUEUE_HOLD_ON_CI_DOWN',
  'FORGE_QUEUE_KEEP_THE_RUN',
  'FORGE_QUEUE_LAND_WHEN_ROOM',
  'FORGE_QUEUE_NO_CARRY_HOLD',
  'FORGE_QUEUE_PARK_EXACT_ON_MAIN_RED',
  'FORGE_QUEUE_PARK_ON_MAIN_RED',
  'FORGE_R2_MAINTENANCE',
  'FORGE_STATE_SOURCE_REUSE_LOCATION',
]);

const receiptFile = directory => join(directory, 'deployment-switches', 'receipts.sqlite');
const publicReceipt = row => ({ ...row, enabled: Boolean(row.enabled) });
const markerName = name => `FORGE_SWITCH_STATE_${name.slice('FORGE_'.length)}`;

export function deploymentSwitchReceipts(directory, from, to, deployments = []) {
  const file = receiptFile(directory);
  if (!existsSync(file)) return [];
  using db = new DatabaseSync(file, { readOnly: true });
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'receipts'").get()) return [];
  return db
    .prepare('SELECT * FROM receipts WHERE startedAt >= ? AND startedAt <= ? ORDER BY startedAt, id')
    .all(from, to)
    .filter(row => !deployments.length || deployments.includes(row.deployment))
    .map(publicReceipt);
}

function convexEnv(deployment, args, input) {
  return new Promise((resolveResult, reject) => {
    const child = execFile(
      process.execPath,
      [resolve('node_modules/convex/bin/main.js'), 'env', ...args, '--deployment', deployment],
      { env: childEnv(), timeout: 30_000, maxBuffer: 32 * 1024 },
      (error, stdout, stderr) => resolveResult({ error, stdout, stderr }),
    );
    child.stdin?.on('error', reject);
    child.stdin?.end(input);
  });
}

export async function readSwitchSetting(deployment, name, run = convexEnv) {
  const { error, stdout, stderr } = await run(deployment, ['get', name]).catch(() => {
    throw Error('SWITCH_READ_FAILED');
  });
  const absent = `Environment variable "${name}" not found`;
  if (
    !stdout &&
    stripVTControlCharacters(stderr)
      .split(/\r?\n/)
      .some(line => line === absent || (line.startsWith(`${absent} (on `) && line.endsWith(')')))
  )
    return null;
  if (error || !stdout.endsWith('\n')) throw Error('SWITCH_READ_FAILED');
  return stdout.replace(/\r?\n$/, '');
}

async function writeSwitchSetting({ deployment, name, enabled, id }) {
  // Convex sends one configuration update for the two settings in the same input.
  const input = `${name}=${enabled ? '1' : '0'}\n${markerName(name)}=${id}\n`;
  const reply = await convexEnv(deployment, ['set', '--force'], input).catch(() => null);
  if (!reply || reply.error) throw Error('SWITCH_WRITE_UNKNOWN');
}

export async function recordDeploymentSwitch(
  directory,
  { id, deployment, name, enabled },
  {
    readSetting = readSwitchSetting,
    writeSetting = writeSwitchSetting,
    actor = () => userInfo().username,
    now = Date.now,
  } = {},
) {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id ?? '') ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)+-\d+$/.test(deployment ?? '') ||
    !switches.has(name) ||
    typeof enabled !== 'boolean'
  )
    throw Error('SWITCH_ARGUMENTS');
  id = id.toLowerCase();
  const ledger = join(directory, 'deployment-switches');
  mkdirSync(ledger, { recursive: true, mode: 0o700 });
  const unlock = journalLock(ledger);
  try {
    using db = new DatabaseSync(receiptFile(directory));
    db.exec(`CREATE TABLE IF NOT EXISTS receipts (
      id TEXT PRIMARY KEY, deployment TEXT NOT NULL, name TEXT NOT NULL,
      enabled INTEGER NOT NULL, actor TEXT NOT NULL, startedAt INTEGER NOT NULL,
      at INTEGER, status TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS receipts_by_time ON receipts (startedAt, id)`);
    const read = () => db.prepare('SELECT * FROM receipts WHERE id = ?').get(id);
    const finish = status => {
      db.prepare('UPDATE receipts SET status = ?, at = ? WHERE id = ?').run(status, now(), id);
      return publicReceipt(read());
    };
    const prior = read();
    if (prior) {
      if (prior.deployment !== deployment || prior.name !== name || Boolean(prior.enabled) !== enabled)
        throw Error('SWITCH_OPERATION_CHANGED');
      if (prior.status !== 'pending') return publicReceipt(prior);
      if ((await readSetting(deployment, markerName(name))) === id) return finish('observed');
      throw Error('SWITCH_WRITE_UNKNOWN');
    }
    const before = (await readSetting(deployment, name)) === '1';
    db.prepare('INSERT INTO receipts VALUES (?, ?, ?, ?, ?, ?, NULL, ?)').run(
      id,
      deployment,
      name,
      Number(enabled),
      actor(),
      now(),
      'pending',
    );
    if (before === enabled) return finish('unchanged');
    await writeSetting({ deployment, name, enabled, id });
    return finish('applied');
  } finally {
    unlock();
  }
}

if (isMainModule(import.meta.url)) {
  const usage =
    'Usage: node scripts/deployment-switch.mjs PRIVATE_SPEND_DIRECTORY DEPLOYMENT SWITCH on|off OPERATION_UUID';
  try {
    const { positionals } = parseArgs({ allowPositionals: true });
    const [directory, deployment, name, state, id] = positionals;
    if (positionals.length !== 5 || !['on', 'off'].includes(state)) throw Error('SWITCH_ARGUMENTS');
    console.log(
      JSON.stringify(
        await recordDeploymentSwitch(resolve(directory), {
          id,
          deployment,
          name,
          enabled: state === 'on',
        }),
      ),
    );
  } catch (error) {
    const code = /^SWITCH_[A-Z_]+$/.test(error.message) ? error.message : 'SWITCH_LOCAL_ERROR';
    console.error(code === 'SWITCH_ARGUMENTS' ? usage : code);
    process.exitCode = 1;
  }
}
