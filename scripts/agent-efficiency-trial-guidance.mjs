// SPDX-License-Identifier: Apache-2.0
import { readFileSync, existsSync, mkdirSync, symlinkSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import {
  seed,
  sourceManifest,
  write,
  digest,
  gradeSource,
  gradeDelivery,
} from './agent-efficiency-trial-fixture.mjs';
const [mode, configuration, pairId, condition] = process.argv.slice(2);
if (!configuration) throw Error('Use prepare|run|summarize CONFIG.json [PAIR git|forge].');
const config = JSON.parse(readFileSync(configuration, 'utf8')),
  plan = JSON.parse(
    readFileSync(new URL('../evals/agent-efficiency-guidance-tasks.json', import.meta.url), 'utf8'),
  );
const base = resolve(config.output),
  node = config.node,
  env = {
    ...process.env,
    PATH: `${config.launcherDirectory ? config.launcherDirectory + ':' : ''}${join(node, '..')}:${process.env.PATH}`,
  };
mkdirSync(base, { recursive: true, mode: 0o700 });
const save = (name, data) => write(join(base, name), JSON.stringify(data, null, 2) + '\n');
const run = (cmd, args, cwd) => {
  const t = performance.now(),
    r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  if (r.status !== 0)
    throw Error(`${cmd} failed (${r.status}): ${(r.stderr || r.stdout || '').slice(-1500)}`);
  return { stdout: r.stdout, seconds: (performance.now() - t) / 1000 };
};
const forge = (root, ...args) => run(node, [config.cli, ...args.slice(0, 1), root, ...args.slice(1)], root);
if (mode === 'prepare') {
  for (const task of plan.pairs)
    for (const kind of task.order) {
      const dir = join(base, task.id, kind),
        root = join(dir, 'owner');
      if (existsSync(join(dir, 'prepared.json'))) continue;
      if (!(task.seed === 'prior670' && kind === 'forge')) mkdirSync(root, { recursive: true, mode: 0o700 });
      else mkdirSync(dir, { recursive: true, mode: 0o700 });
      const start = performance.now(),
        setup = {};
      if (task.seed === 'prior670' && kind === 'forge') {
        const gitRoot = join(base, task.id, 'git/owner'),
          commit = run('git', ['rev-parse', 'HEAD'], gitRoot).stdout.trim();
        const imported = run(node, [config.cli, 'import-native-git', gitRoot, commit, root], gitRoot);
        setup.nativeInitial = JSON.parse(imported.stdout).head;
        setup.bootstrapSeconds = imported.seconds;
        setup.bootstrapBoundary = {
          kind: 'explicit-native-git-import',
          commit,
          seedCommit: config.priorSeedCommit,
          files: JSON.parse(imported.stdout).files,
        };
        symlinkSync(config.priorDependencies, join(root, 'node_modules'), 'dir');
      } else if (task.seed === 'prior670') {
        // Binary archives need file output, never decoding through a text buffer.
        const archive = join(dir, 'seed.tar');
        run('git', ['archive', '--output', archive, config.priorSeedCommit], config.priorGitRoot);
        run('tar', ['-xf', archive, '-C', root], root);
      } else seed(root);
      const instructions =
        'Isolated authorized evaluation. Work only on the supplied task. No network, provider, deployments, other trials, graders, current Forge checkout or canonical writes. Preserve unrelated source. Local OS tools are not sandboxed. Use supplied Node and focused checks. Hidden oracle is outside the workspace.\n';
      if (task.seed !== 'prior670') write(join(root, 'AGENTS.md'), instructions);
      if (kind === 'git') {
        const t = performance.now();
        run('git', ['init', '-q'], root);
        run('git', ['add', '.'], root);
        run(
          'git',
          [
            '-c',
            'user.name=Forge Evaluation',
            '-c',
            'user.email=forge-evaluation@localhost',
            'commit',
            '-qm',
            'Matched seeded task',
          ],
          root,
        );
        setup.bootstrapSeconds = (performance.now() - t) / 1000;
        if (task.seed === 'prior670') {
          write(join(root, '.git/info/exclude'), 'node_modules\n');
          symlinkSync(config.priorDependencies, join(root, 'node_modules'), 'dir');
        }
        setup.initialGitCommit = run('git', ['rev-parse', 'HEAD'], root).stdout.trim();
      } else {
        if (!setup.nativeInitial) {
          const t = performance.now();
          const result = forge(root, 'init-native');
          setup.bootstrapSeconds = (performance.now() - t) / 1000;
          setup.nativeInitial = JSON.parse(result.stdout).head;
        }
        // Only harness bootstrap uses the existing explicit Work command boundary.
        if (task.kind === 'delivery') {
          const command = {
            action: 'define-check',
            name: 'Evaluation focused check',
            executable: node,
            args: task.seed === 'prior670' ? [config.priorCheckScript] : ['scripts/check.mjs'],
            environmentLabel: 'Node24 matched local evaluation',
          };
          const defined = forge(root, 'work', JSON.stringify(command), '0');
          setup.checkId = JSON.parse(defined.stdout).result.id;
          setup.checkDefinition = JSON.parse(defined.stdout).result.definition;
          setup.checkConfigurationSeconds = defined.seconds;
        }
      }
      const toolStart = performance.now(),
        toolPath = join(root, '.forge/evaluation-tooling/nforge');
      const launcher =
        '#!' +
        node +
        '\nimport {spawnSync} from ' +
        JSON.stringify('node:child_process') +
        '; const result=spawnSync(' +
        JSON.stringify(node) +
        ',[' +
        JSON.stringify(config.cli) +
        ',...process.argv.slice(2)],{stdio:' +
        JSON.stringify('inherit') +
        '}); process.exit(result.status??1);\n';
      write(toolPath, launcher);
      chmodSync(toolPath, 0o755);
      setup.taskLocalLauncherSeconds = (performance.now() - toolStart) / 1000;
      setup.taskLocalLauncherSha256 = digest(launcher);
      if (task.temperature === 'warm') {
        const t = performance.now();
        if (task.kind === 'investigation') {
          if (kind === 'forge') forge(root, 'index');
          else run('rg', ['--files', 'src'], root);
          setup.warmPreparation = 'source index or literal file inventory';
        } else {
          run(node, ['scripts/check.mjs'], root);
          setup.warmPreparation = 'matching baseline Node test execution and filesystem warming';
        }
        setup.warmPreparationSeconds = (performance.now() - t) / 1000;
      }
      const manifest = sourceManifest(root);
      save(`${task.id}/${kind}/prepared.json`, {
        taskId: task.id,
        kind,
        root,
        setup,
        files: manifest,
        manifestSha256: digest(JSON.stringify(manifest)),
        setupSeconds: (performance.now() - start) / 1000,
        at: new Date().toISOString(),
      });
    }
  for (const task of plan.pairs) {
    const a = JSON.parse(readFileSync(join(base, task.id, 'git/prepared.json'))),
      b = JSON.parse(readFileSync(join(base, task.id, 'forge/prepared.json')));
    if (a.manifestSha256 !== b.manifestSha256) throw Error(`Seed mismatch: ${task.id}`);
  }
  save('plan.json', { ...plan, configuration: { ...config }, preparedAt: new Date().toISOString() });
  if (config.authorityVerifier) run(node, [config.authorityVerifier, configuration], base);
  console.log(JSON.stringify({ prepared: true, pairs: plan.pairs.length }));
} else if (mode === 'run') {
  const task = plan.pairs.find(t => t.id === pairId);
  if (!task || !['git', 'forge'].includes(condition)) throw Error('Unknown pair/condition.');
  const dir = join(base, pairId, condition),
    prepared = JSON.parse(readFileSync(join(dir, 'prepared.json'), 'utf8'));
  if (existsSync(join(dir, 'timing.json')))
    throw Error('Original dispatch already recorded; never overwrite it.');
  const root = prepared.root,
    final = join(dir, 'final.json'),
    schema = join(dir, 'answer-schema.json');
  const sourceShapes = {
    'investigate-cold-graph': {
      entry: { type: 'string' },
      dependencies: { type: 'array', items: { type: 'string' } },
      couponEligibleAt100: { type: 'boolean' },
      labelAtEmpty: { type: 'string' },
    },
    'investigate-warm-graph': {
      entry: { type: 'string' },
      dependencies: { type: 'array', items: { type: 'string' } },
      taxAt100: { type: 'number' },
      labelAtNull: { type: 'string' },
    },
    'investigate-known-file': {
      eligibleAt99: { type: 'boolean' },
      eligibleAt100: { type: 'boolean' },
      eligibleAt101: { type: 'boolean' },
      discountAt100: { type: 'number' },
    },
  };
  const shape =
    task.kind === 'investigation'
      ? {
          type: 'object',
          properties: sourceShapes[task.id],
          required: Object.keys(sourceShapes[task.id]),
          additionalProperties: false,
        }
      : {
          type: 'object',
          properties: {
            candidate: { type: 'string' },
            checkReceipt: { type: 'string' },
            acceptance: { type: 'string' },
          },
          required: ['candidate', 'checkReceipt', 'acceptance'],
          additionalProperties: false,
        };
  write(schema, JSON.stringify(shape));
  const common = `\nTask-local installed executable: ./.forge/evaluation-tooling/nforge from owner cwd. Wrapper pins Node and installed CLI regardless of login PATH. Same wrapper is available in both arms as ignored tool metadata.\nRuntime: ${node}. Run shell commands with supplied PATH. Do not install dependencies or access the network. Return the required JSON answer. `;
  const transport =
    condition === 'forge'
      ? '\nUse the owner cwd for agent start/finish calls (ROOT may be .); edit only the returned Lane. No installed-package or general-help discovery is needed when supplied commands/check pins are sufficient.'
      : '';
  const skill =
    condition === 'forge' && task.kind === 'delivery'
      ? `\nRead and follow the packaged skill at ${config.skill}. Use installed ${config.agentCommand ?? './.forge/evaluation-tooling/nforge'} agent CLI; do not write SDK integration scripts. Existing owner: ${root}. Configured checkId: ${prepared.setup.checkId ?? 'none'}, immutable expectedDefinition: ${prepared.setup.checkDefinition ?? 'none'}. ${config.forgeInstructions ?? ''}`
      : '';
  const instructions =
    condition === 'git'
      ? task.kind === 'delivery'
        ? `\nUse ordinary Git/search/local tools. Create a feature branch, edit, retain an actual successful check using ${task.seed === 'prior670' ? `${node} ${config.priorCheckScript}` : `${node} scripts/check.mjs`}, then commit exact source/test changes. The ${task.seed === 'prior670' ? '.forge/evaluation-checks' : '.trial'}/check.json and check.log must bind the final committed source. Report the exact candidate commit, receipt path and acceptance=commit. Do not amend the seeded commit.`
        : '\nUse ordinary Git/search/local tools. This is read-only source investigation; no check or commit is needed.'
      : task.kind === 'delivery'
        ? '\nCreate an Intent and Lane and edit only that Lane. Follow the installed v2skill; use optional finish when convenient to checkpoint/compose/run the existing configured check and explicitly accept main with expectedPrevious:null. Existing low-level operations remain available. The returned terminalrun is original recorded evidence and successfulaccept receipt proves pointeradvance; no extraobserve/fullWorkdump is required afterknownterminal outcomes. Report exact candidate State, check receipt/run ID and acceptance ID.'
        : `\nUse ordinary search/read tools on the existing native source root. Do not load Work skill/createWork/index just to read a known file. Installed ${config.agentCommand ?? './.forge/evaluation-tooling/nforge'} CLI provides bounded context/inspect/refs/imports/source when useful; refresh index explicitly if needed. Warm graph alreadycurrent. Packaged skill ${config.skill} is optional onlywhen Work/graphguidance useful. Coveragepartial; absentrelationshipsunknown.`;
  const prompt = task.task + common + instructions + skill + transport;
  write(join(dir, 'prompt.txt'), prompt);
  const args = [
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--json',
    '-s',
    'danger-full-access',
    '-m',
    plan.model,
    '-c',
    'approval_policy="never"',
    '-c',
    `model_reasoning_effort="${plan.reasoning}"`,
    '-C',
    root,
    '--output-schema',
    schema,
    '-o',
    final,
    '-',
  ];
  const startedAt = new Date().toISOString(),
    started = performance.now();
  write(
    join(dir, 'dispatch.json'),
    JSON.stringify({
      startedAt,
      command: 'codex',
      args,
      promptSha256: digest(prompt),
      preparedManifest: prepared.manifestSha256,
    }),
  );
  const child = spawn('codex', args, { cwd: root, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const events = [],
    stderr = [];
  child.stdout.on('data', b => events.push(b));
  child.stderr.on('data', b => stderr.push(b));
  child.stdin.end(prompt);
  let timedOut = false,
    launchError = null,
    killTimer;
  const timeout = setTimeout(
    () => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {}
      killTimer = setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
      }, 5000);
    },
    (config.timeoutSeconds ?? 600) * 1000,
  );
  const exitCode = await new Promise(resolve => {
    child.once('close', resolve);
    child.once('error', error => {
      launchError = String(error);
      resolve(null);
    });
  });
  clearTimeout(timeout);
  if (killTimer) clearTimeout(killTimer);
  write(join(dir, 'events.jsonl'), Buffer.concat(events));
  write(join(dir, 'stderr.log'), Buffer.concat(stderr));
  const timing = {
    startedAt,
    endedAt: new Date().toISOString(),
    dispatchSeconds: (performance.now() - started) / 1000,
    exitCode,
    timedOut,
    launchError,
    timeoutSeconds: config.timeoutSeconds ?? 600,
  };
  save(`${pairId}/${condition}/timing.json`, timing);
  console.log(JSON.stringify({ pairId, condition, ...timing }));
} else if (mode === 'summarize') {
  const results = [];
  for (const task of plan.pairs)
    for (const kind of task.order) {
      const dir = join(base, task.id, kind);
      if (!existsSync(join(dir, 'timing.json'))) {
        results.push({ taskId: task.id, kind, status: 'not_run' });
        continue;
      }
      const timing = JSON.parse(readFileSync(join(dir, 'timing.json'))),
        prepared = JSON.parse(readFileSync(join(dir, 'prepared.json'))),
        events = readFileSync(join(dir, 'events.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map(s => {
            try {
              return JSON.parse(s);
            } catch {
              return { malformed: true };
            }
          });
      const commandMap = new Map();
      for (const event of events)
        if (
          ['item.started', 'item.completed'].includes(event.type) &&
          event.item?.type === 'command_execution'
        )
          commandMap.set(event.item.id, event.item);
      const commands = [...commandMap.values()],
        usage = events.filter(e => e.type === 'turn.completed').map(e => e.usage),
        answer = existsSync(join(dir, 'final.json'))
          ? JSON.parse(readFileSync(join(dir, 'final.json'), 'utf8'))
          : {};
      let candidateRoot = prepared.root,
        workflow = { passed: task.kind === 'investigation' };
      try {
        if (task.kind === 'delivery' && kind === 'forge') {
          const work = JSON.parse(readFileSync(join(prepared.root, '.forge/work/work.json'), 'utf8')),
            move = work.channelMoves.find(m => m.id === answer.acceptance),
            view = work.views.find(v => v.id === move?.viewId),
            check = work.runs.find(r => r.id === answer.checkReceipt);
          candidateRoot = join(dir, 'candidate');
          if (view?.head && config.materializeScript)
            run(node, [config.materializeScript, prepared.root, view.head, candidateRoot], prepared.root);
          workflow = {
            passed:
              !!move &&
              move.status === 'accepted' &&
              move.head === answer.candidate &&
              !!view &&
              view.head === answer.candidate &&
              !!check &&
              check.viewId === view.id &&
              check.head === view.head &&
              check.status === 'passed',
            acceptance: move,
            viewId: view?.id,
            checkId: check?.id,
            check: check
              ? {
                  definition: check.check.definition,
                  environment: check.environment,
                  exitCode: check.exitCode,
                  startedAt: check.startedAt,
                  endedAt: check.endedAt,
                }
              : null,
          };
          if (check) {
            const logs = ['stdout', 'stderr'].map(stream =>
              join(prepared.root, '.forge/work', 'check-' + check.id, stream + '.log'),
            );
            workflow.logs = logs.map(path =>
              existsSync(path)
                ? { path, sha256: digest(readFileSync(path)), bytes: readFileSync(path).length }
                : { path, unavailable: true },
            );
            workflow.passed = workflow.passed && workflow.logs.every(log => !log.unavailable);
          }
        } else if (task.kind === 'delivery') {
          const head = run('git', ['rev-parse', 'HEAD'], prepared.root).stdout.trim(),
            receipt = JSON.parse(
              readFileSync(
                join(
                  prepared.root,
                  task.seed === 'prior670' ? '.forge/evaluation-checks/check.json' : '.trial/check.json',
                ),
              ),
            ),
            files = sourceManifest(prepared.root);
          const clean = run('git', ['diff', '--name-only', 'HEAD'], prepared.root).stdout.trim() === '';
          workflow = {
            passed:
              clean &&
              head === answer.candidate &&
              (answer.acceptance === head || answer.acceptance === 'commit') &&
              receipt.exitCode === 0 &&
              JSON.stringify(receipt.files) === JSON.stringify(files) &&
              digest(
                readFileSync(
                  join(
                    prepared.root,
                    task.seed === 'prior670' ? '.forge/evaluation-checks/check.log' : '.trial/check.log',
                  ),
                ),
              ) === receipt.logSha256,
            commit: head,
            receipt,
          };
        }
      } catch (error) {
        workflow = { passed: false, error: String(error) };
      }
      let oracle;
      try {
        oracle =
          task.kind === 'investigation'
            ? gradeSource(task.id, answer)
            : await gradeDelivery(task.id, candidateRoot, config.typescriptPath);
      } catch (error) {
        oracle = { passed: false, error: String(error) };
      }
      const allowedSource = {
        'deliver-coupon-boundary': 'src/coupon.ts',
        'deliver-tax-rounding': 'src/tax.ts',
        'deliver-empty-label': 'src/label.ts',
        'deliver-prior670-portable-path': 'src/files.ts',
      }[task.id];
      let preservation = true,
        changedPaths = [];
      if (task.kind === 'delivery' && existsSync(candidateRoot)) {
        const before = new Map(prepared.files.map(f => [f.path, f])),
          after = new Map(sourceManifest(candidateRoot).map(f => [f.path, f]));
        changedPaths = [...new Set([...before.keys(), ...after.keys()])].filter(
          path => JSON.stringify(before.get(path)) !== JSON.stringify(after.get(path)),
        );
        preservation = changedPaths.every(path => path === allowedSource || path.startsWith('tests/'));
      }
      const unchanged =
        task.kind === 'investigation'
          ? JSON.stringify(sourceManifest(prepared.root)) === JSON.stringify(prepared.files)
          : undefined;
      const tokenTotals = usage.reduce((s, u) => {
        for (const [k, v] of Object.entries(u ?? {})) if (typeof v === 'number') s[k] = (s[k] ?? 0) + v;
        return s;
      }, {});
      tokenTotals.uncached_input_tokens =
        typeof tokenTotals.input_tokens === 'number' && typeof tokenTotals.cached_input_tokens === 'number'
          ? tokenTotals.input_tokens - tokenTotals.cached_input_tokens
          : null;
      results.push({
        taskId: task.id,
        kind,
        temperature: task.temperature,
        status:
          timing.exitCode === 0 &&
          !timing.timedOut &&
          workflow.passed &&
          oracle.passed &&
          preservation &&
          unchanged !== false
            ? 'passed'
            : 'failed',
        timing,
        setup: prepared.setup,
        setupSeconds: prepared.setupSeconds,
        sharedPackageSeconds: kind === 'forge' ? (config.packageInstallSeconds ?? 0) : 0,
        sharedSkillSeconds: kind === 'forge' ? (config.skillInstallSeconds ?? 0) : 0,
        taskWithPreparationSeconds: timing.dispatchSeconds + prepared.setupSeconds,
        coldStandaloneWithInstallSeconds:
          timing.dispatchSeconds +
          prepared.setupSeconds +
          (kind === 'forge'
            ? (config.packageInstallSeconds ?? 0) +
              (config.skillInstallSeconds ?? 0) +
              (config.launcherSetupSeconds ?? 0)
            : 0),
        tokens: tokenTotals,
        tokenUsageAvailable: usage.length > 0,
        commandCalls: commands.length,
        commandOutputBytes: commands.reduce((n, c) => n + Buffer.byteLength(c.aggregated_output ?? ''), 0),
        generatedCommandBytes: commands.reduce((n, c) => n + Buffer.byteLength(c.command ?? ''), 0),
        failedCommands: commands
          .filter(c => c.exit_code !== 0)
          .map(c => ({ command: c.command, exitCode: c.exit_code, output: c.aggregated_output })),
        workflow,
        oracle,
        sourceUnchanged: unchanged,
        unrelatedSourcePreserved: preservation,
        changedPaths,
        answer,
      });
    }
  save('results.json', { scope: plan.scope, results, at: new Date().toISOString() });
  console.log(
    JSON.stringify(
      results.map(r => ({
        task: r.taskId,
        kind: r.kind,
        status: r.status,
        seconds: r.timing?.dispatchSeconds,
        tokens: r.tokens,
        commands: r.commandCalls,
      })),
    ),
  );
} else throw Error('Unknown mode.');
