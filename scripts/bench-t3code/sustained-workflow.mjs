// SPDX-License-Identifier: Apache-2.0
// Only scratch runner repositories get these groups. Keep the pinned App/OIDC
// planner, check, pack and proof steps in place.
const ending = digits => digits.map(digit => `endsWith(github.run_number, '${digit}')`).join(' || ');
const bucket = (digits, slot) => `((${ending(digits)}) && '${slot}')`;

export function sustainedWorkflow(workflow, controlCommit) {
  if (!/^[a-f0-9]{40}$/.test(controlCommit)) throw Error('Use a full pinned Forge control commit');
  const jobSection = workflow.split('\njobs:\n')[1];
  const jobs = [...(jobSection ?? '').matchAll(/^  ([\w-]+):$/gm)].map(match => match[1]);
  const expectedJobs = ['shard', 'static', 'hosted-plan', 'hosted-check', 'hosted-pack', 'hosted-proof'];
  if (JSON.stringify(jobs) !== JSON.stringify(expectedJobs))
    throw Error('Forge check workflow job layout changed');
  const checks = [['0', '6'], ['1', '7'], ['2', '8'], ['3', '9'], ['4'], ['5']].map((digits, i) =>
    bucket(digits, i),
  );
  const planGroup = `format('bench-plan-{0}', (${ending(['0', '2', '4', '6', '8'])}) && '0' || '1')`;
  const checkGroup = `matrix.shard == 'static' && 'bench-static' || format('bench-check-{0}-{1}', (matrix.shard == '0' && '0' || '1'), ${checks.join(' || ')})`;
  const groups = new Map([
    ['shard', "'bench-optional'"],
    ['static', "'bench-optional'"],
    ['hosted-plan', planGroup],
    ['hosted-check', checkGroup],
    ['hosted-pack', "'bench-optional'"],
    ['hosted-proof', "'bench-optional'"],
  ]);
  // 2 plan + 2×6 test + 1 static + 1 shared auxiliary slot = 16 jobs.
  // queue: max preserves queued jobs; the default concurrency behavior cancels them.
  let checkouts = 0;
  let output = workflow.replace(/^( +)path: control\n\1ref: \$\{\{ github\.sha \}\}$/gm, (_, indent) => {
    checkouts++;
    return (
      indent +
      'path: control\n' +
      indent +
      'repository: NanthAI/nanthai-forge\n' +
      indent +
      'ref: ' +
      controlCommit
    );
  });
  if (checkouts !== 4) throw Error('Forge check workflow control checkouts changed');
  output = output.replace(/^  ([\w-]+):$/gm, (line, job) =>
    groups.has(job)
      ? line + '\n    concurrency:\n      group: \u0024{{ ' + groups.get(job) + ' }}\n      queue: max'
      : line,
  );
  return output;
}
