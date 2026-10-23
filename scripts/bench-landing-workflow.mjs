// SPDX-License-Identifier: Apache-2.0
export function githubWorkflow({ ghRunsOn = 'ubuntu-latest', ghShards = 1 } = {}) {
  const job = (name, index) => `  ${name}:
    runs-on: ${JSON.stringify(ghRunsOn)}
${
  index === 'matrix'
    ? `    strategy:
      fail-fast: false
      matrix:
        shard: [${Array.from({ length: ghShards }, (_, i) => i).join(', ')}]
`
    : ''
}    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: \${{ github.event.pull_request.head.sha || github.sha }}
      - uses: actions/setup-node@v4
        with:
          node-version: '24.22.1'
      - name: Scoped check (same selection as Forge)
        env:
          FORGE_CHECK_SCOPED: '1'
          FORGE_CHECK_BASE: \${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha || github.event.before }}
          FORGE_CHECK_HEAD: \${{ github.event.pull_request.head.sha || github.sha }}
        run: |
          export FORGE_CHECK_CHANGES="$RUNNER_TEMP/changes.json"
          git diff --name-only "$FORGE_CHECK_BASE" "$FORGE_CHECK_HEAD" | node -e 'const f=require("fs");f.writeFileSync(process.env.FORGE_CHECK_CHANGES,JSON.stringify({version:1,comparison:"main",base:process.env.FORGE_CHECK_BASE,head:process.env.FORGE_CHECK_HEAD,paths:f.readFileSync(0,"utf8").split("\\n").filter(Boolean)}))'
          npm ci --ignore-scripts
          node scripts/bench-landing-shard.mjs ${index === 'matrix' ? '${{ matrix.shard }}' : 'static'} ${ghShards}
`;
  return `name: Bench check
on:
  pull_request:
  merge_group:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
${job('static', 'static') + job('tests', 'matrix')}  required:
    name: bench-required
    runs-on: ${JSON.stringify(ghRunsOn)}
    if: \${{ always() }}
    needs: [static, tests]
    steps:
      - run: test "$FAILED" = false
        env:
          FAILED: \${{ contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled') || contains(needs.*.result, 'skipped') }}
`;
}
