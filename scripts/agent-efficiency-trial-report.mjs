// SPDX-License-Identifier: Apache-2.0
// Observational reporting only: no source, Work, run, or original receipt mutations.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
const [privateRoot, outputDirectory, ...requestedVersions] = process.argv.slice(2);
const versions = requestedVersions.length ? requestedVersions : ['v1', 'v2'];
if (!privateRoot || !outputDirectory) throw Error('Use PRIVATE_RECEIPT_ROOT OWNED_EVALS_DIRECTORY.');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const hash = path => (existsSync(path) ? sha(readFileSync(path)) : null);
const metricNames = [
  'input_tokens',
  'cached_input_tokens',
  'uncached_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
];
function totals(rows, shared) {
  const tokens = Object.fromEntries(
    metricNames.map(name => {
      const unavailable = rows.filter(row => !Number.isFinite(row.tokens[name])).length;
      const knownSum = rows.reduce((n, row) => n + (row.tokens[name] ?? 0), 0);
      return [name, { total: unavailable ? null : knownSum, knownSum, unavailableRuns: unavailable }];
    }),
  );
  const dispatchSeconds = rows.reduce((n, r) => n + r.dispatchSeconds, 0);
  const ownerPreparationSeconds = rows.reduce((n, r) => n + r.ownerPreparationSeconds, 0);
  return {
    observations: rows.length,
    passed: rows.filter(r => r.outcome === 'passed').length,
    failed: rows.filter(r => r.outcome === 'failed').length,
    invalidHarness: rows.filter(r => !r.matched).length,
    tokens,
    commandCalls: rows.reduce((n, r) => n + r.commandCalls, 0),
    commandOutputBytes: rows.reduce((n, r) => n + r.commandOutputBytes, 0),
    generatedCommandBytes: rows.reduce((n, r) => n + r.generatedCommandBytes, 0),
    failedCommands: rows.reduce((n, r) => n + r.failures.filter(f => !f.incomplete).length, 0),
    incompleteCommands: rows.reduce((n, r) => n + r.failures.filter(f => f.incomplete).length, 0),
    dispatchSeconds,
    ownerPreparationSeconds,
    taskAndOwnerPreparationSeconds: dispatchSeconds + ownerPreparationSeconds,
    sharedInstallSkillLauncherOnceSeconds: shared,
    fullAttributableSeconds: dispatchSeconds + ownerPreparationSeconds + shared,
  };
}
function aggregate(rows, sharedCosts) {
  const git = totals(
    rows.filter(r => r.condition === 'git'),
    0,
  );
  const forge = totals(
    rows.filter(r => r.condition === 'forge'),
    sharedCosts,
  );
  const ratio = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? a / b : null);
  return {
    git,
    forge,
    forgeDividedByGit: {
      ...Object.fromEntries(
        metricNames.map(name => [name, ratio(forge.tokens[name].total, git.tokens[name].total)]),
      ),
      commandCalls: ratio(forge.commandCalls, git.commandCalls),
      dispatchSeconds: ratio(forge.dispatchSeconds, git.dispatchSeconds),
      taskAndOwnerPreparationSeconds: ratio(
        forge.taskAndOwnerPreparationSeconds,
        git.taskAndOwnerPreparationSeconds,
      ),
      fullAttributableSeconds: ratio(forge.fullAttributableSeconds, git.fullAttributableSeconds),
    },
  };
}
function series(version) {
  const configs = { v1: 'config.json', v2: 'config-v2.json', 'v3-guidance': 'config-v3-guidance.json' };
  const freezes = {
    v1: 'harness-dispatch-freeze.json',
    v2: 'harness-v2-dispatch-freeze.json',
    'v3-guidance': 'harness-v3-guidance-dispatch-freeze.json',
  };
  if (!configs[version]) throw Error('Unknown declared series.');
  const config = json(join(privateRoot, configs[version]));
  const base = config.output,
    results = json(join(base, 'results.json'));
  const plan = json(join(base, 'plan.json'));
  if (results.results.length !== plan.pairs.length * 2 || results.results.some(r => r.status === 'not_run'))
    throw Error(`${version}: not all original dispatches are complete.`);
  const authority = json(join(base, 'authority-validation.json'));
  const frozen = json(join(privateRoot, freezes[version]));
  const shared =
    (config.packageInstallSeconds ?? 0) +
    (config.skillInstallSeconds ?? 0) +
    (config.launcherSetupSeconds ?? 0);
  const rows = results.results.map(r => {
    const dir = join(base, r.taskId, r.kind),
      dispatch = json(join(dir, 'dispatch.json'));
    const guard = authority.results.find(a => a.taskId === r.taskId);
    const matched = guard?.passed === true;
    const check = r.workflow.check;
    const checkDefinitionMatchesConfigured =
      r.taskId.startsWith('deliver-') && r.kind === 'forge'
        ? check?.definition === r.setup.checkDefinition
        : null;
    const runEvents = readFileSync(join(dir, 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .flatMap(line => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    const commands = new Map();
    for (const event of runEvents)
      if (['item.started', 'item.completed'].includes(event.type) && event.item?.type === 'command_execution')
        commands.set(event.item.id, event.item);
    const failures = [...commands.values()]
      .filter(c => c.exit_code !== 0)
      .map(c => ({
        commandSha256: sha(c.command ?? ''),
        outputSha256: sha(c.aggregated_output ?? ''),
        exitCode: c.exit_code ?? null,
        incomplete: c.exit_code == null,
        structuredError: /"code":"([A-Z_]+)"/.exec(c.aggregated_output ?? '')?.[1] ?? null,
      }));
    const workPath = join(dir, 'owner/.forge/work/work.json');
    const originalCheckRuns =
      r.kind === 'forge' && existsSync(workPath)
        ? json(workPath).runs.map(run => ({
            id: run.id,
            viewId: run.viewId,
            head: run.head,
            status: run.status,
            checkId: run.check.id,
            definition: run.check.definition,
            environment: run.environment?.fingerprint ?? null,
            exitCode: run.exitCode ?? null,
            startedAt: run.startedAt,
            endedAt: run.endedAt ?? null,
            logs: ['stdout', 'stderr'].map(stream => {
              const path = join(dir, 'owner/.forge/work', 'check-' + run.id, stream + '.log');
              return {
                stream,
                sha256: hash(path),
                bytes: existsSync(path) ? readFileSync(path).length : null,
              };
            }),
          }))
        : [];
    return {
      taskId: r.taskId,
      outcomeClass: r.taskId.startsWith('investigate-') ? 'investigation' : 'delivery',
      condition: r.kind,
      temperature: r.temperature,
      outcome: r.status,
      matched,
      classification: matched ? r.status : 'invalid-harness',
      invalidReason: matched
        ? null
        : 'The initial authoritative native and Git trees differ; both arms excluded from matched comparison, all costs retained.',
      startedAt: r.timing.startedAt,
      endedAt: r.timing.endedAt,
      dispatchSeconds: r.timing.dispatchSeconds,
      ownerPreparationSeconds: r.setupSeconds,
      bootstrapSeconds: r.setup.bootstrapSeconds,
      configuredCheckPreparationSeconds: r.setup.checkConfigurationSeconds ?? 0,
      taskLocalLauncherPreparationSeconds: r.setup.taskLocalLauncherSeconds ?? 0,
      taskLocalLauncherSha256: r.setup.taskLocalLauncherSha256 ?? null,
      warmPreparationSeconds: r.setup.warmPreparationSeconds ?? 0,
      standaloneFirstUseSharedSeconds: r.kind === 'forge' ? shared : 0,
      standaloneFirstUseTotalSeconds:
        r.timing.dispatchSeconds + r.setupSeconds + (r.kind === 'forge' ? shared : 0),
      tokens: Object.fromEntries(metricNames.map(name => [name, r.tokens[name] ?? null])),
      tokenUsageAvailable: r.tokenUsageAvailable,
      commandCalls: r.commandCalls,
      commandOutputBytes: r.commandOutputBytes,
      generatedCommandBytes: r.generatedCommandBytes,
      failures,
      interfaceUse: {
        skillReadCommands: [...commands.values()].filter(c => (c.command ?? '').includes(config.skill))
          .length,
        usedShortLauncher: [...commands.values()].some(c =>
          /(?:^|[\s'"/])nforge\s+agent\s/.test(c.command ?? ''),
        ),
        sourceGraphCommands: [...commands.values()].filter(c =>
          /(?:\bnforge\s+|\/cli\.js\s+)(?:context|inspect|refs|imports|source|index)\s/.test(c.command ?? ''),
        ).length,
        finishInvocations: [...commands.values()].filter(c =>
          /\sfinish\s+(?:'|"|--command-file)/.test(c.command ?? ''),
        ).length,
      },
      exitCode: r.timing.exitCode,
      timedOut: r.timing.timedOut,
      interrupted: existsSync(join(dir, 'interrupt-reason.json')),
      hiddenOraclePassed: r.oracle.passed,
      hiddenOracleCases: r.oracle.cases ?? null,
      recordedWorkflowPassed: r.workflow.passed,
      checkDefinitionMatchesConfigured,
      originalCheckRuns,
      sourceUnchanged: r.sourceUnchanged ?? null,
      unrelatedSourcePreserved: r.unrelatedSourcePreserved,
      pins: {
        initialGitCommit: guard?.gitCommit ?? null,
        initialNativeState: guard?.nativeState ?? null,
        authoritativeGitFiles: guard?.gitFiles ?? null,
        authoritativeNativeFiles: guard?.nativeFiles ?? null,
        exactBytesAndFileExecutableModes: guard?.exactBytesAndFileExecutableModes ?? false,
        scoredSourceManifestSha256: dispatch.preparedManifest,
        promptSha256: dispatch.promptSha256,
        candidate: r.workflow.acceptance?.head ?? r.workflow.commit ?? null,
        viewId: r.workflow.viewId ?? null,
        checkRunId: r.workflow.checkId ?? null,
        configuredCheckId: r.setup.checkId ?? null,
        configuredCheckDefinition: r.setup.checkDefinition ?? null,
        actualCheckDefinition: check?.definition ?? null,
        actualCheckEnvironment: check?.environment?.fingerprint ?? null,
        actualCheckRuntime: check?.environment?.node ?? r.workflow.receipt?.runtime ?? null,
        acceptanceId: r.workflow.acceptance?.id ?? null,
        actualCheckExitCode: check?.exitCode ?? r.workflow.receipt?.exitCode ?? null,
        actualCheckStartedAt: check?.startedAt ?? r.workflow.receipt?.startedAt ?? null,
        actualCheckEndedAt: check?.endedAt ?? r.workflow.receipt?.endedAt ?? null,
        checkLogs: (r.workflow.logs ?? []).map(log => ({
          stream: basename(log.path),
          sha256: log.sha256 ?? null,
          bytes: log.bytes ?? null,
        })),
        gitRetainedCheckLogSha256: r.workflow.receipt?.logSha256 ?? null,
        originalEventsSha256: hash(join(dir, 'events.jsonl')),
        originalTimingSha256: hash(join(dir, 'timing.json')),
        originalAnswerSha256: hash(join(dir, 'final.json')),
      },
    };
  });
  if (version !== 'v1' && !rows.every(r => r.matched))
    throw Error('Final followup requires actual authoritative parity.');
  if (
    rows.some(
      r =>
        r.condition === 'forge' &&
        r.outcome === 'passed' &&
        r.outcomeClass === 'delivery' &&
        !r.checkDefinitionMatchesConfigured,
    )
  )
    throw Error('Successful delivery evidence has a different configured check definition.');
  const matched = rows.filter(r => r.matched);
  return {
    version,
    declaredPairs: plan.pairs.length,
    packageSha256: config.packageSha256,
    packageSourceState: config.nativeState,
    packageViewId: config.viewId,
    compiledCodeParity: config.codeParityReceipt
      ? {
          sha256: hash(config.codeParityReceipt),
          compiledAndWebIdentical: json(config.codeParityReceipt).compiledAndWebIdentical,
          previousExecutableSourceState: config.previousExecutableSourceState,
        }
      : null,
    skillSha256: hash(config.skill),
    skillBytes: readFileSync(config.skill).length,
    model: plan.model,
    reasoning: plan.reasoning,
    runtime: plan.runtime,
    harness: plan.harness,
    frozenFiles: Object.fromEntries(
      Object.entries(frozen.files).map(([path, value]) => [basename(path), value]),
    ),
    originalResultsSha256: hash(join(base, 'results.json')),
    authorityReceiptSha256: hash(join(base, 'authority-validation.json')),
    authorityValidatedAt: authority.at,
    authorityValidationStage:
      version === 'v1'
        ? 'postdispatch diagnostic: original filesystem comparison missed prior670 authority mismatch'
        : 'predispatch actual native objects versus Git blobs and file/executable modes',
    sharedSetup: {
      packageInstallSeconds: config.packageInstallSeconds,
      skillInstallSeconds: config.skillInstallSeconds,
      launcherSetupSeconds: config.launcherSetupSeconds ?? 0,
      launcherSha256: config.launcherSha256 ?? null,
      totalSeconds: shared,
      allocation:
        'One installation/skill/launcher per series or standalone first use. Aggregate charges once, never once per observation.',
    },
    observations: rows,
    aggregates: {
      matchedSourceThreePairs: matched.some(r => r.outcomeClass === 'investigation')
        ? aggregate(
            matched.filter(r => r.outcomeClass === 'investigation'),
            shared,
          )
        : null,
      matchedDeliveryPairs: aggregate(
        matched.filter(r => r.outcomeClass === 'delivery'),
        shared,
      ),
      matchedAllPairs: aggregate(matched, shared),
      allOriginalObservationsIncludingInvalidHarness: aggregate(rows, shared),
    },
  };
}
const report = {
  schemaVersion: 1,
  status: 'measured',
  generatedAt: new Date().toISOString(),
  scope:
    'Separately frozen matched series, one observation per task and condition. Original v1/v2 seven-pair series and, when requested, the finite three-delivery-pair guidance followup remain separately reported. Descriptive, not a statistical or billed-cost claim.',
  policy:
    'All original dispatches and failures retained. Only both arms of the invalid v1 prior670 pair excluded from matched aggregates. Missing usage is null, never zero.',
  sourceModes:
    'Exact bytes and native file/executable class. Native private ordinary files may be0600 and Git working files0644. Raw permission bits do not define equivalent source identities.',
  tokenAccounting:
    'Uncached input = reported total input minus cached input. Reasoning output reported separately, not added again to output. Interrupted v1 Forge prior670 lacks turn.completed usage; aggregate known sums are lower bounds with unavailable counts.',
  commandAccounting:
    'Distinct command_execution item IDs, including incomplete commands. Several shell subcommands in one execution count once. File-change tool items are not command executions. Original tool events remain private receipts.',
  historicalProtocols:
    "Original plans retain predispatch not-run status and hashes. This measured results artifact records their subsequent dispatch. Before any v2 model session, authoritative fixture parity replaced the invalid prior670 bootstrap: preserve original AGENTS and670 tracked files via explicit native Git import; do not apply the frozen plan's older AGENTS-rewrite sentence. The separately frozen guidance plan has3 actual pairs,6 sessions; its copied seven-observation limitation sentence is stale historical text, not an additional dispatched scope.",
  limitations: [
    'One sequential observation per task and condition; cache, model-server latency and OS variance can differ.',
    'v1 dispatch overlapped other full verification; wall time is descriptive and resource contention is a confound.',
    'v2 uses narrower skill routing, optional finish, existing configured check pins and short launcher together; changes cannot be causally isolated.',
    'Cold means no graph index, not cold OS/file caches. Warm preparation is explicitly measured and included.',
    'Read-only source investigation and complete recorded delivery are separate outcomes. No independent-human acceptance is claimed.',
    'Git bootstrap is an optional compatibility boundary; native Source and Work remain authoritative in Forge arms.',
    'No provider, hosted-egress, GitHub publication, new paid service or billed-dollar inference occurs in these trials.',
    'v2 source agents chose ordinary source/search/Node reads, including the warm graph arm. Cache savings here do not demonstrate graph-context savings.',
    'External hidden grading and administrative experiment construction are outside participant timings; attributable totals cover measured task, owner/bootstrap/check/warm setup and shared package/skill/launcher installation.',
  ],
  invalidPreparation: {
    beforeAnyModelDispatch: true,
    seconds: json(join(privateRoot, 'preparation-failure-1.json')).seconds,
    reason:
      'Harness used a new explicit checkId as an update; corrected creation before any model dispatch. Original preparation evidence retained.',
  },
  unusedPrototype: {
    packageSha256: json(join(privateRoot, 'config-v2.json')).unusedPackagePrototype.sha256,
    installSeconds: json(join(privateRoot, 'config-v2.json')).unusedPackagePrototype.packageInstallSeconds,
    modelDispatches: 0,
  },
  reporterSha256: hash(new URL(import.meta.url)),
  series: versions.map(series),
};
const output = join(outputDirectory, 'agent-efficiency-results.json');
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify({
    output,
    series: report.series.map(s => ({
      version: s.version,
      matched: s.aggregates.matchedAllPairs,
      source: s.aggregates.matchedSourceThreePairs,
      delivery: s.aggregates.matchedDeliveryPairs,
    })),
  }),
);
