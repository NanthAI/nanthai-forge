// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageDocuments } from './package-documents.mjs';

const repository = 'https://github.com/NanthAI/nanthai-forge/blob/main';

// Explicit inventory of what `llms-full.txt` carries: the README and the guides a user or agent
// needs. Internal plans, status/backlog/roadmap, research, license disclosures and the long
// architecture reference are linked from llms.txt but never concatenated. Every `docs/` entry must
// also be in `packageDocuments`, so no unlisted or private document can enter the file.
export const llmsFullPaths = [
  'README.md',
  'docs/README.md',
  'docs/why-forge.md',
  'docs/principles.md',
  'docs/quickstart.md',
  'docs/concepts.md',
  'docs/agents.md',
  'docs/agents/briefings.md',
  'docs/agents/workflow.md',
  'docs/security.md',
  'docs/workflows.md',
  'docs/gh-cli.md',
  'docs/operations/self-hosted-runner.md',
  'docs/operations/runner-fallback.md',
  'docs/operations/github-actions-checks.md',
  'docs/readable-urls.md',
];
export const llmsFullBudgetBytes = 400 * 1024;

// Dated numbers repeated from docs/why-forge.md; tests/llm-discoverability.test.mjs requires every
// quoted figure to appear in that page, so this summary cannot drift from the measurement it cites.
const measured = [
  '2026-10-20 (P1c), landing four already-finished changes: Forge 296.9 s, GitHub merge queue 701.6 s (2.36×). Eight changes: 372.9 s against 1192.9 s (3.20×), an early sample.',
  '2026-10-24 (E3), one of four changes fails a test, against a tuned GitHub merge queue: GitHub was faster. It landed the three good changes in a median 189 s; Forge took 989 s. Forge checks prefixes one after another and that serial recovery lost. No later re-run is recorded.',
  '2026-10-24 and 2026-10-25 (E1), four agents editing the same paragraphs: 0 / 40 finishes dropped; 90 / 90 overlapping pairs and files raised an alert at save time; 2 / 5 replays delivered the first alert to both agents before the second save.',
  'Not established: a token or time advantage over plain Git for a single agent; the coordination evaluation (R3) is pending.',
];

const agentRules = [
  'Run only the tests your change affects (`nforge agent ROOT tests`), plus typecheck, lint and format checks on touched files. Do not run the full suite locally.',
  'Let `finish` compose concurrent Lanes into one check on the project runner. A failing Lane is dropped from the batch and the others still land after passing. Do not rebase or babysit a merge queue.',
  'Read peers and presence before editing; announce your paths and resolve overlap early. These observations are advisory and can be incomplete.',
  'Governance: contributors propose and cannot write source or Channels directly; the owner accepts. Protected paths and review-required policy stop at `awaiting-review` for a person.',
];

const startHere = new Set([
  'docs/README.md',
  'docs/why-forge.md',
  'docs/principles.md',
  'docs/quickstart.md',
  'docs/concepts.md',
]);
const agentDocs = new Set([
  'docs/agents/workflow.md',
  'docs/agents.md',
  'docs/agents/briefings.md',
  'docs/agents/improvement-loop.md',
]);

const referenceDocs = new Set([
  'docs/workflows.md',
  'docs/gh-cli.md',
  'docs/security.md',
  'docs/architecture.md',
  'docs/development.md',
  'docs/operations.md',
  'docs/operations/self-hosted-runner.md',
  'docs/operations/runner-fallback.md',
  'docs/operations/github-actions-checks.md',
  'docs/readable-urls.md',
]);

function describe(path, source) {
  const title = /^# (.+)$/m.exec(source)?.[1] ?? path;
  const paragraph = source
    .split(/\r?\n\s*\r?\n/)
    .find(part => part.trim() && !/^(?:[#>|-]|```|~~~)/.test(part.trim()));
  const note = (paragraph ?? title)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { path, title, note: note.length > 200 ? `${note.slice(0, 197)}…` : note, source };
}

// The packaged inventory is already public. Never scan the workspace: unlisted docs, private
// output and vendor notice trees stay out. A missing listed file throws (ENOENT) and fails the build.
export function llmDocuments(root) {
  const documents = packageDocuments.map(path => describe(path, readFileSync(join(root, path), 'utf8')));
  const known = new Set(packageDocuments);
  const full = llmsFullPaths.map(path => {
    if (path.startsWith('docs/') && !known.has(path))
      throw new Error(`llms-full source is not in packageDocuments: ${path}`);
    return describe(path, readFileSync(join(root, path), 'utf8'));
  });
  const skill = readFileSync(join(root, 'skills/forge-agent/SKILL.md'), 'utf8');
  const links = selected => selected.map(doc => `- [${doc.title}](/${doc.path}): ${doc.note}`).join('\n');
  const summary =
    'Forge is a source host and workspace for people and AI agents changing the same code at the same time. Isolated Lanes, recorded checks and accepted Channels coordinate concurrent work.';
  const introduction = `# NanthAi:Forge\n\n> ${summary}\n\n`;
  const reference = documents.filter(doc => referenceDocs.has(doc.path));
  const rest = documents.filter(
    doc => !startHere.has(doc.path) && !agentDocs.has(doc.path) && !referenceDocs.has(doc.path),
  );
  const llms =
    `${introduction}## Start here\n\n${links(documents.filter(doc => startHere.has(doc.path)))}\n` +
    `- [README](${repository}/README.md): ${describe('README.md', full[0].source).note}\n\n` +
    `## For agents\n\n${agentRules.map(rule => `- ${rule}`).join('\n')}\n\n` +
    `${links(documents.filter(doc => agentDocs.has(doc.path)))}\n` +
    `- [forge-agent skill](${repository}/skills/forge-agent/SKILL.md): ${describe('skills/forge-agent/SKILL.md', skill).note}\n\n` +
    `## Measured results\n\n${measured.map(line => `- ${line}`).join('\n')}\n\nMethod, sources and caveats: [Why Forge](/docs/why-forge.md).\n\n` +
    `## Reference\n\n${links(reference)}\n\n` +
    `## Optional\n\n${links(rest)}\n\n` +
    `## Full text\n\n- [Curated documentation](/llms-full.txt): The README and ${llmsFullPaths.length - 1} user and agent guides, concatenated. Plans, status, research, license disclosures and the other documents are linked above, not included.\n`;
  const text =
    `${introduction}The README and the user and agent guides follow in a fixed order. Plans, status, research, license disclosures and the architecture reference are separate documents linked from /llms.txt.\n\n` +
    full
      .map(
        doc =>
          `---\n\nSource: ${doc.path === 'README.md' ? `${repository}/README.md` : `/${doc.path}`}\n\n${doc.source}`,
      )
      .join('\n\n');
  if (Buffer.byteLength(text) > llmsFullBudgetBytes)
    throw new Error(
      `llms-full.txt is ${Buffer.byteLength(text)} bytes; the budget is ${llmsFullBudgetBytes}. Trim llmsFullPaths.`,
    );
  return [
    { fileName: 'llms.txt', source: llms },
    { fileName: 'llms-full.txt', source: text },
    ...documents.map(doc => ({ fileName: doc.path, source: doc.source })),
  ];
}
