// SPDX-License-Identifier: Apache-2.0
// A Forge check job runs the Candidate's own code in one step: the check step (`forge-check.mjs`,
// or the hosted supervisor's `hosted-actions-job.mjs run`). Everything the job attests or caches
// must come from steps that ran no Candidate code (Issue 432164bf), so in such a job:
// - the check step is the job's last step and has no `id` (no later step reads what it wrote);
// - the check step's env names no secret and no workflow token;
// - every cache save comes before the check step, and no `actions/cache` with an automatic
//   post-job save is used; a dependency-cache save is seeded on the default branch (or by the
//   server's main-audit `save` flag), never from a Candidate ref;
// - in a check workflow, every cache restore treats a stalled download as a miss (SEGMENT_DOWNLOAD_TIMEOUT_MINS) and
//   every `npm ci` has a timeout, so a slow cache or registry fails fast (friction d99fcf3a);
// - no step plans and runs in one step (the removed fold).
const checkStep = /\brun:\s*node\s+(?:\S*\/)?(?:forge-check\.mjs|hosted-actions-job\.mjs\s+run)\b/;
const defaultBranch = "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)";

/** Jobs of a workflow text as `{ name, line, steps: [{ line, text }] }` (indentation-based). */
function jobs(text) {
  const lines = text.split(/\r?\n/),
    out = [];
  let inJobs = false,
    job = null,
    step = null;
  lines.forEach((line, index) => {
    if (/^jobs:\s*$/.test(line)) return void (inJobs = true);
    if (/^\S/.test(line)) return void (inJobs = false);
    if (!inJobs) return;
    const name = /^ {2}([\w-]+):\s*$/.exec(line);
    if (name) {
      job = { name: name[1], line: index + 1, steps: [] };
      step = null;
      return void out.push(job);
    }
    if (!job) return;
    if (/^ {4}\S/.test(line)) step = null;
    if (/^ {6}- /.test(line)) {
      step = { line: index + 1, text: '' };
      job.steps.push(step);
    }
    if (step) step.text += `${line}\n`;
  });
  return out;
}

/** Findings for one workflow text; `path` only labels them (locations, never source). */
export function candidateStepFindings(path, text) {
  const findings = [];
  if (/FORGE_ACTIONS_FOLD/.test(text))
    findings.push(`${path}: plan and check run in separate steps (no FORGE_ACTIONS_FOLD)`);
  const all = jobs(text);
  // Restore and install bounds apply to every job of a check workflow (they hold its verdict).
  const checkWorkflow = all.some(job => job.steps.some(step => checkStep.test(step.text)));
  for (const job of all) {
    const where = step => `${path}:${step.line}`;
    for (const step of checkWorkflow ? job.steps : []) {
      if (
        /uses:\s*actions\/cache\/restore@/.test(step.text) &&
        !/SEGMENT_DOWNLOAD_TIMEOUT_MINS:/.test(step.text)
      )
        findings.push(`${where(step)}: bound the cache restore (env SEGMENT_DOWNLOAD_TIMEOUT_MINS)`);
      if (/\brun:\s*npm ci\b/.test(step.text) && !/^\s+timeout-minutes:/m.test(step.text))
        findings.push(`${where(step)}: give npm ci a timeout-minutes`);
    }
    const first = job.steps.findIndex(step => checkStep.test(step.text));
    if (first < 0) continue;
    job.steps.forEach((step, index) => {
      const candidate = checkStep.test(step.text);
      if (candidate && /^ {6}- id:|^ {8}id:/m.test(step.text))
        findings.push(`${where(step)}: the check step has no id (nothing reads its outputs)`);
      if (candidate && /\$\{\{\s*(?:secrets\.|github\.token)/.test(step.text))
        findings.push(`${where(step)}: the check step gets no secret or workflow token`);
      if (index > first && !candidate)
        findings.push(`${where(step)}: no step follows the check step in job ${job.name}`);
      if (/uses:\s*actions\/cache@/.test(step.text))
        findings.push(`${where(step)}: use actions/cache/restore and an explicit save before the check step`);
      if (/uses:\s*actions\/cache\/save@/.test(step.text)) {
        if (index > first) findings.push(`${where(step)}: save caches before the check step, never after it`);
        const ifLine = /^\s*(?:- )?if:\s*(.*)$/m.exec(step.text)?.[1] ?? '';
        const dependency = /forge-deps|deps_cache/.test(step.text);
        if (dependency && !ifLine.includes(defaultBranch) && !/deps_cache[^\n]*\)\.save\b/.test(ifLine))
          findings.push(`${where(step)}: seed the dependency cache only on the default branch`);
      }
    });
  }
  return findings;
}
