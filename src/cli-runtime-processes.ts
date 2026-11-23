// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { childEnv } from '../scripts/child-env.mjs';
import { invariant } from './errors.js';
import { processLiveness } from './local-process.js';
import { canonicalRoot } from './root-paths.js';

/** Legacy runtimes predate leases. Consume argv privately; keep only paths and kernel identities. */
export type CliRuntimeUser = {
  pid: number;
  path: string;
  retiredService?: { startTime: string };
};

function retiredService(path: string, args: string[]) {
  const script = basename(path);
  return (
    script === 'auto-exchange.js' ||
    (script === 'cli.js' && args[0] === 'host' && args.slice(2).includes('--sync-agent'))
  );
}

// ps flattens argv, so a path containing a space and "--sync-agent" could
// look like a retireable command. Only signal after inspecting exact argv.
function darwinArgv(pid: number) {
  const script =
    'my $m=pack("i3",1,49,$ARGV[0]);my $b="\\0"x1048576;my $n=pack("Q",length($b));' +
    'syscall(202,$m,3,$b,$n,0,0)==0 or die;my $argc=unpack("i",$b);' +
    'my $s=substr($b,4,unpack("Q",$n)-4);$s=~s/^[^\\0]*\\0+// or die;' +
    'my @a=split(/\\0/,$s,-1);$argc>=2 && $argc<=@a or die;print join("\\0",@a[0..$argc-1]);';
  try {
    return execFileSync('/usr/bin/perl', ['-e', script, String(pid)], {
      encoding: 'utf8',
      timeout: 1000,
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\0');
  } catch {
    return [];
  }
}

export function cliRuntimePaths(): CliRuntimeUser[] {
  if (process.platform === 'linux')
    return readdirSync('/proc')
      .filter(name => /^\d+$/.test(name))
      .flatMap(pid => {
        try {
          const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
          const path = args[1];
          if (!(args[0] === 'node' || args[0]?.endsWith('/node')) || !path?.startsWith('/')) return [];
          const user: CliRuntimeUser = { pid: Number(pid), path };
          if (retiredService(path, args.slice(2))) {
            const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
            const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
            if (fields[1] === '1' && fields[2] === pid && fields[19])
              user.retiredService = { startTime: fields[19] };
          }
          return [user];
        } catch {
          return [];
        }
      });
  invariant(
    process.platform === 'darwin',
    'CLI_PROCESS_TABLE_UNAVAILABLE',
    'Legacy runtime inspection is unavailable; keep older builds.',
  );
  return execFileSync(
    '/bin/ps',
    ['-axww', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'lstart=', '-o', 'command='],
    {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 16 * 1024 * 1024,
      env: childEnv({ extra: { LC_ALL: 'C', LANG: 'C', TZ: 'UTC' } }),
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  )
    .split('\n')
    .flatMap(row => {
      const match =
        /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.{24})\s+(?:\/.*?\/node|node)\s+(\/.*?\/dist\/[\w-]+\.js)(?:\s+(.*)|$)/.exec(
          row,
        );
      if (!match) return [];
      const [, pid, parent, group, startTime, path, args] = match;
      const user: CliRuntimeUser = { pid: Number(pid), path: path! };
      if (
        parent === '1' &&
        group === pid &&
        (basename(path!) === 'auto-exchange.js' ||
          (basename(path!) === 'cli.js' && /^host .+ --sync-agent(?:\s|$)/.test(args ?? '')))
      )
        user.retiredService = { startTime: startTime! };
      return [user];
    });
}

/** Only orphaned services removed by hosted-only mode, from an unselected
 * managed build of this installation. Other detached work retains its runtime. */
export function retiredOwnerServices(installation: string, selected: string, users: CliRuntimeUser[]) {
  const builds = join(canonicalRoot(installation), 'builds');
  return users.flatMap(user => {
    if (!user.retiredService) return [];
    const path = canonicalRoot(user.path);
    const dist = dirname(path);
    const build = dirname(dist);
    if (
      basename(dist) !== 'dist' ||
      dirname(build) !== builds ||
      !/^[a-f0-9]{12,64}$/.test(basename(build)) ||
      build === selected ||
      !existsSync(join(build, '.managed-cli'))
    )
      return [];
    try {
      const [, script, ...args] =
        process.platform === 'darwin'
          ? darwinArgv(user.pid)
          : readFileSync(`/proc/${user.pid}/cmdline`, 'utf8').split('\0');
      if (script !== user.path || !retiredService(script, args)) return [];
    } catch {
      return [];
    }
    const identity = { pid: user.pid, ...user.retiredService };
    return [identity];
  });
}

export function stopRetiredOwnerServices(users: ReturnType<typeof retiredOwnerServices>) {
  let stopped = 0;
  for (const identity of users) {
    if (processLiveness(identity) !== 'alive') continue;
    try {
      process.kill(identity.pid, 'SIGTERM');
      stopped++;
    } catch {
      /* It exited or could not be signalled; never escalate. */
    }
  }
  return stopped;
}
