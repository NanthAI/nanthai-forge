// SPDX-License-Identifier: Apache-2.0
// Env-print guard (df2ba360): scripts, workflows and docs must not run or instruct commands that
// print environment values or full process listings. A dev key leaked 2026-10-22 through a
// process listing. Findings name file, line and rule only; never the matched text.
import { extname } from 'node:path';

// Name-only helpers: files that may mention the patterns because they define or test this rule.
export const ENV_PRINT_ALLOWLIST = new Set(['scripts/check-env-print.mjs', 'scripts/check-brief.mjs']);
// A marker exempts its own line and the next one, e.g. a helper that prints names only.
const MARKER = /forge-env-print:\s*name-only/;
// A sentence that forbids a command is a rule, not an instruction to run it.
const NEGATED = /\b(?:never|not|no|don't|dont|avoid|forbid(?:den|s)?|instead of|without|refuse[sd]?)\b/i;

const SHELL_RULES = [
  ['printenv', /(?:^|[\s;|&(`$])printenv\b/],
  ['convex env list', /\bconvex\s+env\s+list\b/],
  ['bare env', /(?:^|[;|&(`]|\$\()\s*(?:sudo\s+)?env\s*(?:$|[|>;&`)])/],
  ['pgrep -fl', /\bpgrep\s+(?:-\w+\s+)*-\w*(?:f\w*l|l\w*f|a)\w*\b/],
  // macOS `ps -E` and BSD `ps e`/`ps auxeww` append each process's environment.
  ['ps -E', /(?:^|[\s;|&(`])ps\s+(?:-\w+\s+)*(?:-\w*E\w*|[aAjluvwx]*e[aAjluvwx]*)(?=\s|$|[|;&`)])/],
];
// Outside code spans only distinctive command names count; `env` and `ps` are ordinary words.
const PROSE_RULES = new Set(['printenv', 'convex env list', 'pgrep -fl']);
const CODE_RULES = [
  ['console print of process.env', /\b(?:console\.\w+|process\.std(?:out|err)\.write)\(\s*process\.env\b/],
  ['whole process.env serialized', /\b(?:JSON\.stringify|inspect)\(\s*process\.env\s*[,)]/],
  [
    'spawned env/printenv/pgrep/ps',
    /\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)\(\s*['"`](?:printenv|env['"`]\s*(?:\)|,\s*\[\s*\]|,\s*\{)|pgrep['"`]\s*,\s*\[[^\]]*['"`]-\w*(?:f\w*l|l\w*f|a)|ps['"`]\s*,\s*\[[^\]]*['"`]-\w*E)/,
  ],
];
// Every rule needs one of these words; lines without them skip the rule set.
const TRIGGER = /env|pgrep|\bps\b/;
const SHELL_TEXT = new Set(['.sh', '.bash', '.zsh', '.yml', '.yaml']);
const CODE_TEXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
// Synthetic tests may replay these patterns inside fixtures; the guard's own test needs them.
const SCOPE = /^(?:scripts|src|convex|netlify|web\/src|\.github|docs|design|evals|models)\/|^[^/]+\.md$/;

/** Rule names a shell command line breaks; ignores `#` comments and stringed command lines. */
export function shellHazards(line) {
  if (!TRIGGER.test(line)) return [];
  const code = line.replace(/(^|\s)#.*$/, '$1');
  return SHELL_RULES.filter(([, rule]) => rule.test(code)).map(([name]) => name);
}

/** Rule names a prose or instruction line breaks; sentences that forbid the command pass. */
export function proseHazards(line) {
  if (!TRIGGER.test(line)) return [];
  return (
    line
      // Sentences end at . ! or ? after a word and before a capital; an ellipsis does not end one.
      .split(/(?<=[\w)`'"][.!?])\s+(?=[A-Z])/)
      .filter(sentence => !NEGATED.test(sentence))
      .flatMap(sentence => {
        // A lone `env` span is usually a field name; it counts only when the sentence says to run it.
        const run = /\b(?:run|execute|type|enter|paste)\b/i.test(sentence);
        const spans = [...sentence.matchAll(/`([^`]+)`/g)]
          .filter(match => run || match[1].trim() !== 'env')
          .flatMap(match => shellHazards(match[1]));
        const prose = shellHazards(sentence.replace(/`[^`]*`/g, ' ')).filter(name => PROSE_RULES.has(name));
        return [...spans, ...prose];
      })
  );
}

function markdownHazards(text) {
  let fence = null;
  return text.split('\n').map(line => {
    const open = /^\s*(`{3,}|~{3,})\s*([\w-]*)/.exec(line);
    if (open && !fence) {
      const lang = open[2].toLowerCase();
      fence = {
        mark: open[1],
        kind: /^(?:|sh|bash|zsh|shell|console|text)$/.test(lang)
          ? 'shell'
          : /^(?:js|mjs|ts|tsx|jsx|javascript|typescript)$/.test(lang)
            ? 'code'
            : null,
      };
      return [];
    }
    if (fence) {
      if (line.trim().startsWith(fence.mark)) {
        fence = null;
        return [];
      }
      if (NEGATED.test(line)) return [];
      // Shell fences often embed JS (`node <<'JS'`), so both rule sets apply there.
      const code = fence.kind ? lineCodeHazards(line) : [];
      return fence.kind === 'shell' ? [...shellHazards(line.replace(/^\s*\$\s+/, '')), ...code] : code;
    }
    return proseHazards(line);
  });
}

function lineCodeHazards(line) {
  if (!TRIGGER.test(line)) return [];
  return [
    ...CODE_RULES.filter(([, rule]) => rule.test(line)).map(([name]) => name),
    // A command in a shell string passed to exec/execSync.
    ...[...line.matchAll(/\bexec(?:Sync)?\(\s*['"`]([^'"`]+)['"`]/g)].flatMap(([, command]) =>
      shellHazards(command),
    ),
  ];
}

/** Findings for one repository file; `path` is repository-relative with `/` separators. */
export function envPrintFindings(path, text) {
  if (!SCOPE.test(path) || ENV_PRINT_ALLOWLIST.has(path) || !TRIGGER.test(text)) return [];
  const extension = extname(path);
  const perLine =
    extension === '.md'
      ? markdownHazards(text)
      : SHELL_TEXT.has(extension)
        ? // A YAML `run:` value (or list item) is a shell line once its key is stripped.
          text.split('\n').map(line => shellHazards(line.replace(/^\s*(?:-\s+)?(?:run:\s*)?/, '')))
        : CODE_TEXT.has(extension)
          ? text.split('\n').map(lineCodeHazards)
          : null;
  if (!perLine) return [];
  const lines = text.split('\n');
  return perLine.flatMap((hazards, index) => {
    if (!hazards.length || MARKER.test(lines[index]) || (index > 0 && MARKER.test(lines[index - 1])))
      return [];
    return [
      `${path}:${index + 1}: prints environment values or process listings (${[...new Set(hazards)].join(', ')}); print names only or mark a name-only helper with "forge-env-print: name-only"`,
    ];
  });
}
