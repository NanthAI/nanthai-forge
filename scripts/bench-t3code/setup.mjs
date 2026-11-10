#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Rebuild the B1.5d bench environment from scratch (Issue e082f30a).
//   scripts/bench-t3code/setup --dry                 print every step, its state and its cost; reads only
//   scripts/bench-t3code/setup --live [flags]        run the missing steps (idempotent; resumes)
// Flags: --base-source PATH   git repo or bundle holding the base commit (owner-held)
//        --new-base           the source holds a NEW base (different commit id): a new base, see the plan
//        --installer-sha256 H  sha256 of the reviewed Vite+ installer (setup stops and prints it first)
//        --replace-forge-project  host a NEW Forge project though config names one that does not answer
//        --dogfood-project ID  the project whose mirror maps the CLI State to Git
//        --only a,b            run only these steps (ids as printed by --dry)
// BENCH_ROOT (required, absolute; bench-root.mjs) is the bench folder. --live needs it to hold
// the owner's config.json and tasks.json. Creates only what the manifest records: see teardown.
import { pathToFileURL } from 'node:url';
import { benchRoot } from './bench-root.mjs';
import { realContext, runSetup } from './env.mjs';

export function parseArgs(argv) {
  const flags = {};
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw Error(`${a} needs a value`);
      return v;
    };
    if (a === '--dry') opt.dry = true;
    else if (a === '--live') opt.live = true;
    else if (a === '--new-base') flags.newBase = true;
    else if (a === '--replace-forge-project') flags.replaceForgeProject = true;
    else if (a === '--base-source') flags.baseSource = value();
    else if (a === '--installer-sha256') flags.installerSha256 = value();
    else if (a === '--dogfood-project') flags.dogfoodProject = value();
    else if (a === '--only') opt.only = value().split(',');
    else throw Error(`unknown argument ${a}`);
  }
  return { flags, opt };
}

export async function main(argv = process.argv.slice(2), ctxFactory = realContext) {
  let B;
  try {
    B = benchRoot();
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  const { flags, opt } = parsed;
  if (!opt.dry && !opt.live) {
    console.error(
      'Pick one: --dry (reads only, prints every step and its cost) or --live (creates a public repo and a hosted project).',
    );
    return 2;
  }
  const ctx = ctxFactory(B, flags);
  const r = await runSetup(ctx, { dry: Boolean(opt.dry), only: opt.only ?? null });
  return r.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main();
