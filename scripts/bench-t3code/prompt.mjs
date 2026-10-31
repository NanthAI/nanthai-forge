// B1.5d prompt: identical template in both arms except the SOURCE WORKFLOW paragraph.
export const WORKFLOW_SLOT = '\u0000WORKFLOW\u0000';

export function template(task) {
  return `You are a coding agent working on the t3code monorepo (TypeScript, pnpm workspaces managed by Vite+ \`vp\`). Several other agents are working on other changes in the same repository at the same time. Your working directory is your own workspace; edit files only there. Do not use the network to look up this change or any upstream pull request.

YOUR TASK
${task.prompt}

Implement the change in the source, and add or update tests for the behavior described. Keep unrelated code unchanged. The project's check runs \`bash .bench/ci.sh\`: it installs the toolchain and runs the test suites of packages/shared, packages/provider-pi, packages/client-runtime and packages/source-control-forgejo. Dependencies for those packages are already installed in your workspace, so you do not need \`vp install\`. You may run focused tests locally, for example \`vp test run --config ../../vite.config.ts --dir . src/<file>.test.ts\` inside the package (packages/client-runtime uses \`vp test run src/<file>.test.ts\`).

${WORKFLOW_SLOT}

You are done only when your change is on main. If the check fails or your change conflicts with work that landed first, fix it and try again. Finish with a short summary: what you changed, the tests you ran, and how the change reached main.`;
}

export const workflows = {
  github: ({ repository, branch }) =>
    `SOURCE WORKFLOW (Git + GitHub): your workspace is a git clone of ${repository} on main. Create branch \`${branch}\`, commit, \`git push -u origin ${branch}\`, open a pull request with \`gh pr create --base main --fill\`, then add it to the merge queue with \`gh pr merge --squash --auto\`. The required check \`bench-check\` runs on the pull request and again in the merge queue; the queue merges when it passes. Follow progress with \`gh pr checks\` and \`gh pr view --json state,mergedAt,mergeStateStatus\`. If the pull request is removed from the queue or a check fails, fix it (bring in main with \`git pull --no-rebase origin main\` if needed), push, and enqueue again. Only use ${repository}; never open pull requests anywhere else.`,
  forge: ({ projectName }) =>
    `SOURCE WORKFLOW (Forge): your workspace is a Forge Lane of the hosted project ${projectName}, already started for this task; run \`nforge\` commands from the workspace root. Land with \`nforge agent . land --save '{"message":"<one-line summary>"}'\`: it saves your edits, syncs with main, runs the project's check (\`bash .bench/ci.sh\`) on the project's runner and lands the change when it passes. Read the JSON receipt: \`phase\` \`landed\` means done. On a failed check it lists the failure (\`nforge agent . log '{"operationId":"RUN_ID","stream":"stderr","tail":4096}'\` reads more); fix and run \`land --save\` again. On a sync conflict it lists files with <<<<<<< lane / >>>>>>> main markers; resolve them and run \`land --save\` again. \`nforge agent . status '{}'\` shows your Lane. \`nforge agent . land --help\` lists options.`,
};

export function prompt(task, arm, context) {
  return template(task).replace(WORKFLOW_SLOT, workflows[arm](context));
}
