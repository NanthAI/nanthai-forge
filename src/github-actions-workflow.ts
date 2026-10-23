// SPDX-License-Identifier: Apache-2.0
import type { ModalPlan } from './modal-plan.js';

/** Only generated in the run export; never changes the accepted candidate. */
export function githubActionsWorkflow(runsOn = 'ubuntu-latest') {
  return `name: Forge check
run-name: forge-check/\${{ inputs.runId }}
on:
  workflow_dispatch:
    inputs:
      runId:
        required: true
        type: string
      plan:
        required: true
        type: string
permissions:
  contents: read
jobs:
  shard:
    if: \${{ inputs.plan != '[]' }}
    name: forge-shard-\${{ matrix.shard }}
    runs-on: ${JSON.stringify(runsOn)}
    strategy:
      fail-fast: false
      matrix:
        shard: \${{ fromJSON(inputs.plan) }}
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: '24.22.1'
      - run: node scripts/forge-check.mjs
        env:
          FORGE_ACTIONS_PLAN: .github/forge-check-plan.json
          FORGE_ACTIONS_SHARD: \${{ matrix.shard }}
  static:
    name: forge-static
    runs-on: ${JSON.stringify(runsOn)}
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: '24.22.1'
      - run: node scripts/forge-check.mjs
        env:
          FORGE_ACTIONS_PLAN: .github/forge-check-plan.json
          FORGE_ACTIONS_SHARD: static
`;
}
export function githubActionsRecipe(plan: ModalPlan) {
  const { pin, head, definition, selection, groups, standard, interaction, command } = plan;
  return { pin, head, definition, selection, groups, standard, interaction, command };
}
