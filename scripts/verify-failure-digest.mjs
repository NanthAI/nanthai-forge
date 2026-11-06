// SPDX-License-Identifier: Apache-2.0
// What a failed verify step says at the tail of the log. The hosted job keeps only the
// last 4 KiB of output as its failure summary, so a step that failed early (check-foundation,
// lint, format, documents) was reduced to the timings row `FAIL 4.8s check`. The digest repeats,
// after the timings, the failing step, the command that reproduces it and its first error lines.
import { relative } from 'node:path';

export const FAILED_STEP_MARKER = '[failed-step]';
const lineChars = 200;
const maxLines = 3;
/** Whole digest budget; the hosted summary tail is 4096 bytes and also carries the timings. */
const digestBytes = 1500;
const signal =
  /\berror\b|assert|expected|unlisted|exceed|budget|cannot|not found|invalid|mismatch|✖|\bfail(?:ed|ure)?\b|violat|missing|forbidden/i;
// Progress, banners and stack frames say nothing about the cause.
const noise = /^\s*(?:at |>|npm (?:notice|warn)|\[[\w :-]+\] (?:ok|FAILED) )/;

// A thrown error or an `ERROR:` line names the cause better than the lines around it
// (`node:assert:128`, `throw new AssertionError(obj)`).
const cause = /^(?:ERROR\b|Error\b|[A-Z]\w*Error(?: \[[A-Z_]+\])?: \S)/;

/** The first lines of a failed step's output that carry its cause, each bounded. */
export function firstErrorLines(text, max = maxLines) {
  const lines = String(text)
    .split(/\r?\n/)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(line => line && !noise.test(line));
  const tiers = [lines.filter(line => cause.test(line)), lines.filter(line => signal.test(line)), lines];
  const picked = [];
  for (const tier of tiers)
    for (const line of tier) if (picked.length < max && !picked.includes(line)) picked.push(line);
  return picked.map(line => line.slice(0, lineChars));
}

/** `npm run check (node scripts/check-foundation.mjs)` or the plain command, relative to cwd. */
export function describeStep({ command, args, npmCli, scripts = {}, execPath = process.execPath, cwd }) {
  const shown = value => (value === execPath ? 'node' : value.startsWith('/') ? relative(cwd, value) : value);
  if (args[0] === npmCli) {
    const script = args.filter(arg => !['run', '--silent'].includes(arg) && arg !== npmCli).at(-1);
    const inner = scripts[script];
    return `npm run ${script}${inner ? ` (${inner.slice(0, 100)})` : ''}`;
  }
  return [shown(command), ...args.map(shown)].join(' ').slice(0, 160);
}

/** `[failed-step] NAME :: COMMAND :: LINE ; LINE`, one per failed step, within the budget. */
export function failureDigest(steps) {
  const out = [];
  let used = 0;
  for (const step of steps) {
    const row = `${FAILED_STEP_MARKER} ${step.name} :: ${step.command} :: ${step.lines.join(' ; ') || 'no error line was printed'}`;
    // The first failed step is always named in full; later ones yield to the budget.
    if (out.length && used + row.length > digestBytes) {
      out.push(
        `${FAILED_STEP_MARKER} +${steps.length - out.length} more failed steps: ${steps
          .slice(out.length)
          .map(item => item.name)
          .join(', ')}`.slice(0, 240),
      );
      break;
    }
    out.push(row);
    used += row.length + 1;
  }
  return out;
}
