// SPDX-License-Identifier: Apache-2.0
/** Collect every onboarding omission before failing; keep the existing registries authoritative. */
export function tableRegistrationFindings({ tables, placement, purge, budgets, owners = [], helpCurrent }) {
  const findings = [];
  for (const { name, projectOwned } of tables) {
    if (!placement.includes(`\`${name}\``)) findings.push(`${name}: docs/data-placement.d/tables/${name}.md`);
    if (projectOwned && !purge.has(name)) findings.push(`${name}: convex/projectPurgeInventory.ts`);
    for (const [scenario, phases] of Object.entries(budgets).filter(
      ([, value]) => value.immediate && value.retained,
    ))
      for (const phase of ['immediate', 'retained'])
        if (!(name in phases[phase]) && !(name in (phases.perProject?.[phase] ?? {})))
          findings.push(`${name}: tests/landing-storage-budget.d/${name}.json (${scenario}/${phase})`);
  }
  findings.push(...owners.map(name => `owner-only guard: ${name}`));
  if (!helpCurrent)
    findings.push(
      'generated help: refresh docs/agents/workflow.d/sections/0310-generated-contract.md with hostedAgentHelpMarkdown()',
    );
  return findings;
}
