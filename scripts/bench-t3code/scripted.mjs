// B1.5d no-model protocol/stress driver: dry edits exercise real coordination.
import { writeFileSync, chmodSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { overlapClass } from './coordination.mjs';

/** Shared-file group of a task for dry runs ('' for disjoint tasks). */
export const dryGroup = task =>
  overlapClass(task.overlap).startsWith('disjoint')
    ? ''
    : overlapClass(task.overlap).replace(/[^a-z0-9]+/gi, '-');

export function scriptedForge(binDir) {
  copyFileSync(new URL('./forge-protocol.mjs', import.meta.url), join(binDir, 'forge-protocol.mjs'));
  const driver = join(binDir, 'scripted-forge.mjs');
  writeFileSync(
    driver,
    `import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { driveForge } from './forge-protocol.mjs';
const [task, group] = process.argv.slice(2);
const laneId = JSON.parse(readFileSync('.forge/hosted-lane.json', 'utf8')).selection.laneId;
mkdirSync('.bench/dry', { recursive: true });
writeFileSync('.bench/dry/' + task + '.md', 'dry run ' + task + ' ' + new Date().toISOString() + '\\n');
if (group) appendFileSync('.bench/dry/group-' + group + '.md', task + '\\n');
try {
  await driveForge({ root: process.cwd(), laneId, message: 'bench dry run: ' + task });
} catch (error) {
  console.error(JSON.stringify({ event: 'product-friction', detail: error.message }));
  process.exitCode = 1;
}
`,
  );
  const file = join(binDir, 'scripted-forge.sh');
  writeFileSync(file, `#!/bin/bash\nexec /usr/local/bin/node ${JSON.stringify(driver)} "$@"\n`);
  chmodSync(file, 0o755);
  return file;
}
