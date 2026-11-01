// B1.5d scripted no-model agents for dry runs. Each writes one file of its own plus a line in
// its overlap group's shared file, so same-group tasks really collide and the coordination
// counters (notices, acks, conflicts, extra attempts) are exercised end to end.
import { writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { overlapClass } from './coordination.mjs';

/** Shared-file group of a task for dry runs ('' for disjoint tasks). */
export const dryGroup = task =>
  overlapClass(task.overlap).startsWith('disjoint')
    ? ''
    : overlapClass(task.overlap).replace(/[^a-z0-9]+/gi, '-');

export function scriptedForge(binDir) {
  const file = join(binDir, 'scripted-forge.sh');
  writeFileSync(
    file,
    `#!/bin/bash
set -uo pipefail
task="$1"; group="$2"
lane=$(/usr/local/bin/node -e 'console.log(require(process.cwd() + "/.forge/hosted-lane.json").selection.laneId)')
mkdir -p .bench/dry && echo "dry run $task $(date -u +%FT%TZ)" > ".bench/dry/$task.md"
[ -n "$group" ] && echo "$task" >> ".bench/dry/group-$group.md"
for attempt in 1 2 3 4 5 6 7 8; do
  out=$(nforge agent . land --save "{\\"message\\":\\"bench dry run: $task\\"}" 2>&1); echo "$out"
  echo "$out" | grep -q '"phase":"landed"' && exit 0
  if echo "$out" | grep -q OVERLAP_UNANSWERED; then
    nforge agent . ack "{\\"laneId\\":\\"$lane\\",\\"choice\\":\\"accept-order\\"}"
  elif echo "$out" | grep -q PREFLIGHT_REQUIRED; then
    nforge agent . preflight "{\\"laneId\\":\\"$lane\\"}"
  fi
  # A composition conflict: sync as the error says, keep both sides of the conflict files in
  # the resolve root it opens, resolve, then land again from there (what an agent does).
  if echo "$out" | grep -q COMPOSITION_CONFLICT; then
    next=$(echo "$out" | /usr/local/bin/node ${JSON.stringify(join(binDir, 'scripted-forge-resolve.mjs'))})
    [ -n "$next" ] && [ -d "$next" ] && cd "$next"
  fi
  sleep 10
done
exit 1
`,
  );
  chmodSync(file, 0o755);
  writeFileSync(
    join(binDir, 'scripted-forge-resolve.mjs'),
    `import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const out = readFileSync(0, 'utf8');
const candidateId = out.match(/sync '\\{\\\\?"candidateId\\\\?":\\\\?"([0-9a-f-]{36})/)?.[1];
if (!candidateId) process.exit(0);
const last = text => JSON.parse(text.split('\\n').filter(l => l.startsWith('{')).at(-1));
const nf = (root, verb, body) => last(execFileSync('nforge', ['agent', root, verb, JSON.stringify(body)], { encoding: 'utf8' }));
const synced = nf('.', 'sync', { candidateId });
const conflict = synced.result?.conflict;
if (!conflict?.root) process.exit(0);
for (const path of conflict.paths ?? []) {
  const file = join(conflict.root, path);
  const text = readFileSync(file, 'utf8').split('\\n').filter(l => !/^(<<<<<<< |=======$|>>>>>>> )/.test(l));
  writeFileSync(file, text.join('\\n'));
}
const { laneId, operationId } = conflict.next ?? {};
nf(conflict.root, 'resolve', { laneId, operationId });
console.log(conflict.root);
`,
  );
  return file;
}
