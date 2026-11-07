#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Remove what `setup` created, and only that (the manifest BENCH_ROOT/setup-manifest.json).
//   scripts/bench-t3code/teardown --dry            list what would go
//   scripts/bench-t3code/teardown --live [--keep deps,meta]
// Standing rule: the temporary public fork is deleted after the bench. --keep leaves whole
// steps (ids as printed by setup --dry) in place and in the manifest, e.g. the multi-GB deps.
import { pathToFileURL } from 'node:url';
import { benchRoot } from './bench-root.mjs';
import { realContext, runTeardown } from './env.mjs';

export async function main(argv = process.argv.slice(2), ctxFactory = realContext) {
  let B;
  try {
    B = benchRoot();
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  let dry = false,
    live = false,
    keep = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry') dry = true;
    else if (argv[i] === '--live') live = true;
    else if (argv[i] === '--keep' && argv[i + 1] && !argv[i + 1].startsWith('--'))
      keep = argv[++i].split(',');
    else {
      console.error(`unknown or incomplete argument ${argv[i]}`);
      return 2;
    }
  }
  if (!dry && !live) {
    console.error('Pick one: --dry or --live.');
    return 2;
  }
  const r = await runTeardown(ctxFactory(B, {}), { dry, keep });
  return r.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main();
