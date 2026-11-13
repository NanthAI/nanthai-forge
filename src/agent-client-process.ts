// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { windowsPowerShell } from './local-process.js';

/** One process as `ps` reports it. */
export type ProcessInfo = { ppid: number; command: string; started: string };
export type ProcessReader = (pid: number) => ProcessInfo | undefined;

// Wrappers between the client and the CLI: shells and launchers never identify the client.
const WRAPPERS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'fish',
  'ksh',
  'tcsh',
  'env',
  'nohup',
  'sudo',
  'timeout',
  'xargs',
  'login',
  'script',
  'nforge',
]);
const MAX_DEPTH = 16;

/** Local executable, parent and start metadata (no arguments or network). Unavailable processes return undefined. */
export const readProcess: ProcessReader = pid => {
  try {
    if (process.platform === 'win32') {
      const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if($p){[pscustomobject]@{ppid=[int]$p.ParentProcessId;command=$p.Name;started=$p.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString()}|ConvertTo-Json -Compress}`;
      return JSON.parse(
        execFileSync(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-Command', script], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 5000,
        }),
      ) as ProcessInfo;
    }
    const out = execFileSync('ps', ['-o', 'ppid=,lstart=,comm=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    // "<ppid> <Dow Mon DD HH:MM:SS YYYY> <command>"
    const match = /^(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d{4})\s+(.+)$/.exec(out);
    return match ? { ppid: Number(match[1]), started: match[2]!, command: match[3]! } : undefined;
  } catch {
    return undefined;
  }
};

/** The agent client's own process: the nearest ancestor of the CLI that is not a shell or launcher
 * (Claude Code, the Codex app server). pid plus start time, so a reused pid is another process.
 * Undefined when the ancestry cannot be read; callers then scope by session id alone. Clients that
 * run subagents inside one process (Claude Code, Codex threads) expose no per-subagent identity
 * here; only separate client processes sharing a session id are told apart (3676f3e1). */
export function agentClientProcess(
  read: ProcessReader = readProcess,
  from: number = process.ppid,
): string | undefined {
  let pid = from;
  for (let depth = 0; depth < MAX_DEPTH && pid > 1; depth++) {
    const info = read(pid);
    if (!info) return undefined;
    const name = basename(info.command.split(/\s+/)[0] ?? '').replace(/^-/, '');
    if (!WRAPPERS.has(name)) return `${pid}@${info.started}`;
    pid = info.ppid;
  }
  return undefined;
}

let detected: { value: string | undefined } | undefined;
/** This process's client, read once: its ancestry cannot change while it runs. */
export function detectedClientProcess() {
  detected ??= { value: agentClientProcess() };
  return detected.value;
}
