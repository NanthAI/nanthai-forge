// SPDX-License-Identifier: Apache-2.0
// Disposable zoo fixture preparation: source refs and the single declared comparison workflow.
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildRepository } from './shapes.mjs';
import { ciScript, zooWorkflow } from './suite-lib.mjs';

async function isolateWorkflows(fork, expectedPaths, ok) {
  const selectedPath = '.github/workflows/zoo-ci.yml';
  const raw = await ok('gh', [
    'api',
    '--paginate',
    'repos/' + fork + '/actions/workflows?per_page=100',
    '--jq',
    '.workflows[] | {id,path,state}',
  ]);
  const workflows = raw.trim()
    ? raw
        .trim()
        .split('\n')
        .map(line => JSON.parse(line))
    : [];
  if (
    workflows.some(w => !Number.isInteger(w.id) || typeof w.path !== 'string' || typeof w.state !== 'string')
  )
    throw Error('Invalid fixture workflow inventory');
  const registered = new Set(workflows.map(w => w.path));
  const missing = expectedPaths.filter(path => path !== selectedPath && !registered.has(path));
  if (missing.length) throw Error('Fixture workflow inventory incomplete: ' + missing.join(', '));
  for (const workflow of workflows) {
    if (workflow.path !== selectedPath && workflow.state === 'active')
      await ok('gh', [
        'api',
        '-X',
        'PUT',
        'repos/' + fork + '/actions/workflows/' + workflow.id + '/disable',
      ]);
    if (workflow.path === selectedPath && workflow.state !== 'active')
      await ok('gh', ['api', '-X', 'PUT', 'repos/' + fork + '/actions/workflows/' + workflow.id + '/enable']);
  }
}

/** Declared toolchain steps for the plain-GitHub workflow, from the same module Forge's own
 * generated workflow uses (a built checkout's dist/). */
async function setupSteps(cfg, entry) {
  if (!entry.toolchains && !entry.cache) return '';
  const { declaredSetupSteps } = await import(
    pathToFileURL(join(cfg.forgeCheckout, 'dist/actions-toolchains.js')).href
  );
  return declaredSetupSteps({
    ...(entry.toolchains ? { toolchains: entry.toolchains } : {}),
    ...(entry.cache ? { cache: entry.cache } : {}),
  });
}

export async function provisionOne(cfg, entry, shapes, run) {
  const ok = async (cmd, args, options) => {
    const r = await run(cmd, args, options);
    if (r.code) throw Error(`${cmd} ${args.slice(0, 3).join(' ')}: ${r.stderr.slice(-300)}`);
    return r.stdout;
  };
  const exists = async fork => (await run('gh', ['repo', 'view', fork, '--json', 'name'])).code === 0;
  const files = {
    '.forge-zoo/ci.sh': { data: Buffer.from(ciScript(entry, shapes)), mode: '100755' },
    '.github/workflows/zoo-ci.yml': {
      data: Buffer.from(zooWorkflow(await setupSteps(cfg, entry))),
      mode: '100644',
    },
  };
  const work = mkdtempSync(join(tmpdir(), 'zoo-provision-'));
  let workflowPaths = [];
  const pauseActions = () =>
    ok('gh', ['api', '-X', 'PUT', 'repos/' + entry.fork + '/actions/permissions', '-F', 'enabled=false']);
  const sourceWorkflows = async directory =>
    (await ok('git', ['-C', directory, 'ls-tree', '-r', '-z', '--name-only', 'HEAD', '.github/workflows']))
      .split('\0')
      .filter(path => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path));
  try {
    if (entry.synthetic) {
      if (!(await exists(entry.fork))) {
        await ok('gh', [
          'repo',
          'create',
          entry.fork,
          '--public',
          '--description',
          `bench-zoo synthetic fixture (${entry.synthetic}); temporary`,
        ]);
      }
      await pauseActions();
      const extra = Object.entries(files).map(([path, f]) => ({ path, ...f }));
      const built = buildRepository(shapes[entry.synthetic], extra);
      try {
        workflowPaths = await sourceWorkflows(built.dir);
        await ok('git', [
          '-C',
          built.dir,
          'push',
          '--force',
          `https://github.com/${entry.fork}.git`,
          'refs/heads/main:refs/heads/main',
        ]);
      } finally {
        rmSync(built.dir, { recursive: true, force: true });
      }
    } else {
      if (!(await exists(entry.fork))) {
        const name = entry.fork.split('/')[1];
        await ok('gh', [
          'repo',
          'fork',
          entry.upstream,
          '--org',
          'NanthAI',
          '--fork-name',
          name,
          '--clone=false',
        ]);
        for (let i = 0; i < 30 && !(await exists(entry.fork)); i++)
          await new Promise(r => setTimeout(r, 2000));
      }
      await pauseActions();
      // Plain clones and workflow discovery use the fixture default; match the import's declared ref.
      await ok('gh', ['repo', 'edit', entry.fork, '--default-branch', entry.ref]);
      const env = { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' };
      const dir = join(work, 'fork');
      await ok(
        'git',
        [
          'clone',
          '--quiet',
          '--depth',
          '1',
          '--branch',
          entry.ref,
          `https://github.com/${entry.fork}.git`,
          dir,
        ],
        { env },
      );
      for (const [path, f] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), f.data, { mode: f.mode === '100755' ? 0o755 : 0o644 });
      }
      await ok('git', ['-C', dir, 'add', '-A', '.forge-zoo', '.github/workflows/zoo-ci.yml']);
      const dirty = await run('git', ['-C', dir, 'status', '--porcelain']);
      if (dirty.stdout.trim()) {
        await ok('git', [
          '-C',
          dir,
          '-c',
          'user.name=zoo',
          '-c',
          'user.email=zoo@example.invalid',
          'commit',
          '--quiet',
          '-m',
          'zoo: check script and workflow',
        ]);
        await ok('git', ['-C', dir, 'push', '--quiet', 'origin', `HEAD:refs/heads/${entry.ref}`]);
      }
      workflowPaths = await sourceWorkflows(dir);
    }
    // GitHub hides a fresh fork's workflow inventory while Actions is disabled. All pushes have
    // finished; enabling Actions emits no push event. Discover and isolate before returning the
    // fixture to its caller, and pause again on any incomplete or failed inventory operation.
    await ok('gh', ['api', '-X', 'PUT', `repos/${entry.fork}/actions/permissions`, '-F', 'enabled=true']);
    try {
      await isolateWorkflows(entry.fork, workflowPaths, ok);
    } catch (error) {
      await pauseActions();
      throw error;
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
