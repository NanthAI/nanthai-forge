#!/usr/bin/env node
// B1.5d pinned harness (B3): a clean checkout of one landed commit of nanthai-forge, outside
// every Lane root, that the driver and cells run from. The Convex meter needs the convex
// package, so node_modules links to the one CLI build's dependencies (read-only).
//   node scripts/bench-t3code/pin.mjs SHA   -> prints the checkout path
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const sha = process.argv[2];
if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw Error('usage: pin.mjs FULL_SHA');
const B = process.env.BENCH_ROOT || join(homedir(), 'NanthAI/forge-bench/b15d');
const dir = join(B, 'harness', sha.slice(0, 12));
const git = (...args) =>
  execFileSync('git', ['-C', dir, ...args], {
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
  }).trim();
if (!existsSync(join(dir, '.git'))) {
  mkdirSync(dir, { recursive: true });
  git('init', '-q');
  git('remote', 'add', 'origin', 'https://github.com/NanthAI/nanthai-forge');
  git('fetch', '-q', '--depth', '1', 'origin', sha);
  git('checkout', '-q', 'FETCH_HEAD');
}
if (git('rev-parse', 'HEAD') !== sha) throw Error('BENCH_PIN_MISMATCH');
if (!existsSync(join(dir, 'node_modules')))
  symlinkSync(
    realpathSync(join(homedir(), 'NanthAI/forge-cli/current/node_modules')),
    join(dir, 'node_modules'),
  );
console.log(dir);
