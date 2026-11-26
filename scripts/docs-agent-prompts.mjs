// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi

// Classify procedural pages independently of the prompt copy. Published pages in
// these folders default to guides unless they are references, plans or historical runbooks.
const references = new Set([
  'docs/README.md',
  'docs/access-contract.md',
  'docs/agents/agent-weight.md',
  'docs/agents/brief-template.md',
  'docs/agents/briefings.md',
  'docs/agents/cli-gaps.md',
  'docs/agents/ecosystems.md',
  'docs/agents/hosted-parity.md',
  'docs/agents/improvement-loop.md',
  'docs/agents/lint-rules.md',
  'docs/agents/perf-claims.md',
  'docs/agents/regression-ladder.md',
  'docs/agents/speed-budgets.md',
  'docs/architecture.md',
  'docs/backlog.md',
  'docs/billing.md',
  'docs/concepts.md',
  'docs/contributor-agreement.md',
  'docs/data-placement.md',
  'docs/decisions.md',
  'docs/dependency-licenses.md',
  'docs/forge-only-rules.md',
  'docs/limits.md',
  'docs/native-dependency-licenses.md',
  'docs/operations/compute-egress.md',
  'docs/operations/cost-architecture-options.md',
  'docs/operations/cost-to-serve.md',
  'docs/operations/egress.md',
  'docs/operations/gate-parity.md',
  'docs/operations/hosted-landing-contract.md',
  'docs/operations/hosted-source-worker.md',
  'docs/operations/landing-batches.md',
  'docs/operations/landing-queue-invariants.md',
  'docs/operations/legacy-item-shapes.md',
  'docs/operations/legacy-small-shapes.md',
  'docs/operations/legacy-storage-cleanup.md',
  'docs/operations/legacy-view-rows.md',
  'docs/operations/legacy-work-layout.md',
  'docs/operations/optimistic-landing.md',
  'docs/operations/product-analytics.md',
  'docs/operations/storage-compaction.md',
  'docs/operations/storage-inventory.md',
  'docs/parallel-work-defaults.md',
  'docs/people.md',
  'docs/phase5-close.md',
  'docs/phase5-plan.md',
  'docs/phase6-close.md',
  'docs/phase6-plan.md',
  'docs/phase7-plan.md',
  'docs/pre-queue-checks.md',
  'docs/principles.md',
  'docs/r2-storage-plan.md',
  'docs/readable-urls.md',
  'docs/roadmap.md',
  'docs/run-evidence.md',
  'docs/security.md',
  'docs/status.md',
  'docs/why-forge.md',
]);
const needsPrompt = path =>
  /^docs\/(?:[^/]+\.md|(?:guides|agents|operations)\/.+\.md)$/.test(path) && !references.has(path);

// The first check belongs to the task. Keep it to one sentence and leave commands in the guide.
const firstChecks = {
  'docs/quickstart.md': 'Check my target repository, Node version and Forge sign-in first.',
  'docs/access.md': 'Check the project, my role and the current access settings first.',
  'docs/agents.md': 'Check my agent client, the project address and the access it already has first.',
  'docs/agents/hooks.md': 'Check the installed CLI and current hook settings first.',
  'docs/agents/lead.md': 'Check active Items, ownership, checks and any benchmark hold first.',
  'docs/agents/review-api.md': 'Check the saved Lane, review route and available budget first.',
  'docs/agents/workflow.md': 'Check the hosted checkout, the current Item or Lane and its status first.',
  'docs/development.md': 'Check the Forge checkout, Node version and target environment first.',
  'docs/git-serving.md': 'Check the project URL, Git access and the ref I need first.',
  'docs/guides/access.md': 'Check the Forge app, signed-in account and current device or Lane holder first.',
  'docs/guides/agents.md': 'Check the hosted checkout and current Item or Lane first.',
  'docs/guides/billing.md': 'Check the account and the billing period I want to understand first.',
  'docs/guides/event-feed.md': 'Check the project, event consumer and last recorded position first.',
  'docs/guides/export.md': 'Check the project, my access and which source and Work I need to keep first.',
  'docs/guides/oversight.md': 'Check the project and the live status of the work I need to inspect first.',
  'docs/guides/people.md': 'Check the repository or folder, Forge app and account access first.',
  'docs/guides/plan.md': 'Check the project and search for an existing matching Item first.',
  'docs/guides/review.md': 'Check the Candidate, exact source and required check result first.',
  'docs/guides/secrets.md':
    'Check the project, device reach and whether the value is for Development or Checks first.',
  'docs/operations.md': 'Check the deployment, project and current operating state first.',
  'docs/operations/ci-status-checks.md':
    'Check the repository, CI provider and current required check first.',
  'docs/operations/cli-update.md': 'Check the installed CLI version, channel and target State first.',
  'docs/operations/contract-suites.md': 'Check the suite and the isolated target it would run against first.',
  'docs/operations/convex-spend.md': 'Check the intended deployment, reporting window and read access first.',
  'docs/operations/governance.md': 'Check the project policy, my role and the affected paths first.',
  'docs/operations/github-actions-checks.md':
    'Check the current check definition, runner repository and permissions first.',
  'docs/operations/github-app.md': 'Check the deployment, repository and existing GitHub App access first.',
  'docs/operations/github-project-import.md':
    'Check the repository, source ref and access with the import preview first.',
  'docs/operations/hosted-durability.md':
    'Check the source deployment, backup and isolated restore target first.',
  'docs/operations/import-benchmark-guard.md':
    'Check the existing benchmark guard and isolated target first.',
  'docs/operations/recovery-drill.md':
    'Check the backup or surviving hosted copy and the replacement machine first.',
  'docs/operations/runner-fallback.md': 'Check the configured runner and the reported check failure first.',
  'docs/operations/self-hosted-runner.md':
    'Check the project, check definition and intended runner machine first.',
  'docs/operations/source-exchange.md':
    'Check the project, source pins and any existing operation receipt first.',
  'docs/planning.md': 'Check the project and search planning for matching Items first.',
  'docs/workflows.md': 'Check the checkout, hosted project and landing policy first.',
};

export const agentGuidePaths = Object.keys(firstChecks);

export function agentGuidePrompt(path) {
  if (!Object.hasOwn(firstChecks, path)) return undefined;
  const twin = `/${path}`;
  return {
    twin,
    text: [
      `Read ${twin}.`,
      `${firstChecks[path]} Then follow the guide’s checklist for my task.`,
      'Use IDs and URLs from live replies or ask me for them. Keep secrets out of output and leave production untouched.',
      'Ask me before making external or irreversible changes. Report what you verified.',
    ].join('\n'),
  };
}

export function checkAgentGuides(documents) {
  for (const path of agentGuidePaths) {
    if (!documents.get(path)?.source.trim()) throw new Error(`How-to page needs a Markdown twin: ${path}`);
  }
  for (const path of documents.keys())
    if ((needsPrompt(path) || Object.hasOwn(firstChecks, path)) && !firstChecks[path]?.trim())
      throw new Error(`How-to page needs an agent prompt: ${path}`);
}
