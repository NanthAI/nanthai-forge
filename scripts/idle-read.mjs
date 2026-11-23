// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Counts the Convex executions one signed-in bot tab causes on one project, once opened and then idle.
// Usage: node scripts/idle-read.mjs --project PROJECT_ID --path HANDLE/SLUG [--minutes 30] [--settle 30]
// Attribution: every project function logs FORGE_PROJECT_EXECUTION with its projectId; each completion carries
// usageStats. Use a quiet scratch project so no other tab shares it. Prints counts and bytes only.
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { openBotCredentialStore } from './ui-shots/bot-credential-store.mjs';
import { botPasskey } from './ui-shots/bot-credentials.mjs';
import { launchBotBrowser } from './ui-shots/browser.mjs';
import { observePasskeySession, signInWithPasskey } from './ui-shots/passkey-session.mjs';

const { values } = parseArgs({
  options: {
    project: { type: 'string' },
    path: { type: 'string' },
    minutes: { type: 'string', default: '30' },
    settle: { type: 'string', default: '30' },
  },
});
if (!values.project || !values.path) {
  console.error('Supply --project PROJECT_ID and --path HANDLE/SLUG.');
  process.exit(2);
}
const minutes = Number(values.minutes);
const settleMs = Number(values.settle) * 1000;
const { data } = await openBotCredentialStore(homedir());
const credential = botPasskey(data.passkey, data.passkey.origin);

const rows = [];
const logs = spawn('npx', ['convex', 'logs', '--jsonl', '--success'], {
  cwd: data.convexCwd,
  stdio: ['ignore', 'pipe', 'pipe'],
});
// A dead log stream would read as a quiet project, so its exit invalidates the whole measurement.
let logsEnded = null;
let logLines = 0;
logs.stderr.resume();
logs.on('exit', code => (logsEnded = `exit ${code}`));
logs.on('error', () => (logsEnded = 'spawn error'));
createInterface({ input: logs.stdout }).on('line', line => {
  logLines++;
  if (!line.includes(values.project)) return;
  try {
    const row = JSON.parse(line);
    if (row.kind !== 'Completion') return;
    const mine = row.logLines?.some(entry =>
      entry.messages?.some(text => text.includes('FORGE_PROJECT_EXECUTION') && text.includes(values.project)),
    );
    if (!mine) return;
    rows.push({
      at: row.timestamp * 1000,
      fn: row.identifier,
      type: row.udfType,
      bytes: row.usageStats?.databaseReadBytes ?? Number.NaN,
      docs: row.usageStats?.databaseReadDocuments ?? Number.NaN,
      writes: row.usageStats?.databaseWriteDocuments ?? 0,
    });
  } catch {
    // A partial line is not a completion.
  }
});
await new Promise(done => setTimeout(done, 5000)); // let the log stream attach

const browser = await launchBotBrowser({ kind: 'passkey' });
try {
  const page = await (await browser.newContext()).newPage();
  const session = observePasskeySession(page, credential.deployment);
  await signInWithPasskey(page, credential, session, 45_000);
  const opened = Date.now();
  await page.goto(new URL(values.path, credential.origin).href, { waitUntil: 'domcontentloaded' });
  await new Promise(done => setTimeout(done, settleMs + minutes * 60_000));
  await new Promise(done => setTimeout(done, 5000)); // late log lines
  const open = rows.filter(row => row.at >= opened - 2000 && row.at < opened + settleMs);
  const problem = logsEnded
    ? `the log stream ended early (${logsEnded})`
    : !logLines
      ? 'the log stream delivered no lines'
      : !open.some(row => row.fn === 'projectLiveLine:read')
        ? 'the opening burst never showed projectLiveLine:read for this project (wrong project/path, or the tab did not load it)'
        : open.some(row => !Number.isFinite(row.bytes))
          ? 'a completion carried no usage data'
          : null;
  if (problem) throw new Error(`NOT MEASURED: ${problem}.`);
  const summary = (from, to) => {
    const part = rows.filter(row => row.at >= from && row.at < to);
    const byFn = {};
    for (const row of part) {
      byFn[row.fn] ??= { calls: 0, bytes: 0, docs: 0, writes: 0 };
      byFn[row.fn].calls++;
      byFn[row.fn].bytes += row.bytes;
      byFn[row.fn].docs += row.docs;
      byFn[row.fn].writes += row.writes;
    }
    return {
      calls: part.length,
      bytes: part.reduce((n, row) => n + row.bytes, 0),
      docs: part.reduce((n, row) => n + row.docs, 0),
      writes: part.reduce((n, row) => n + row.writes, 0),
      byFn,
    };
  };
  const settled = opened + settleMs;
  console.log(
    JSON.stringify(
      {
        project: values.project,
        openedAt: new Date(opened).toISOString(),
        settleSeconds: settleMs / 1000,
        open: summary(opened - 2000, settled),
        idleFirst10Min: summary(settled, settled + 10 * 60_000),
        idleWhole: summary(settled, settled + minutes * 60_000),
        idleMinutes: minutes,
      },
      null,
      1,
    ),
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  logs.kill();
  await browser.close();
}
