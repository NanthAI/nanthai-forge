// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageDocuments, packageDocumentData, readDocument } from './package-documents.mjs';
import { AGENT_DEFAULTS, BOARD_LINE, agentDefaultLines } from './agent-default-lines.mjs';

import { coreVerbs, landSaveForm } from './agent-verb-forms.mjs';

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
  'docs/guides/people.md',
  'docs/guides/agents.md',
  'docs/guides/plan.md',
  'docs/guides/review.md',
  'docs/guides/access.md',
  'docs/guides/oversight.md',
  'docs/guides/billing.md',
  'docs/guides/export.md',
  'docs/concepts.md',
  'docs/agents.md',
  'docs/agents/briefings.md',
  'docs/agents/workflow.md',
  'docs/parallel-work-defaults.md',
  'docs/security.md',
  'docs/workflows.md',
  'docs/operations/self-hosted-runner.md',
  'docs/operations/runner-fallback.md',
  'docs/operations/github-actions-checks.md',
  'docs/readable-urls.md',
];
// Soft size line, in bytes. Crossing it only warns: the file is a sum over every Lane's docs, so a
// hard limit fails combined landings that each pass alone (2026-11-05). Trim when you see the warning.
export const llmsFullWarnBytes = 400 * 1024;

// The measured-results block comes from Why Forge, also retained verbatim in the skill.
// Commands derive from the same verb contract as CLI dispatch.
const workflow = `Lifecycle verbs: ${coreVerbs.map(verb => `\`${verb}\``).join(', ')}. Use \`${landSaveForm}\` (bare \`land\`) to save, run affected checks, update from main, check and land under project policy; follow the commands it prints. \`tests {candidateId}\` reads a Candidate's test selection.`;

const agentRules = [
  workflow,
  'Hosted CLI actions and parameters come from the enforced contract: run `nforge agent ROOT --help` in the hosted checkout or `nforge docs agents/hosted`. Keep this turn active on unfinished work. After admission use the receipt command: `wait {operationIds:[ORIGINAL_UUID],until:"acceptance"}`; it blocks up to its budget (540 s agent mode, --budget/maxWaitMs); repeat on IN PROGRESS. Before admission replay the full original request including message.',

  'Hosted automatic-accept projects group landings by default and pipeline up to six exact-source groups (checks.concurrency overrides, 1–16); acceptance.landing: serial opts out. Pre-queue admission (acceptance.admissionCheck, default "full") checks each change before it joins a group; a failed shared check splits the group to isolate the failing changes.',
  'Run affected checks plus typecheck, lint and format (`land --save` runs the affected preflight itself). Do not run the full suite locally.',
  'Let `land --save` compose concurrent Lanes into one check on the project runner. A failing Lane is dropped from the batch and the others still land after passing. Do not rebase or babysit a merge queue.',
  'For hosted Lanes, read start/save/status behindMain and any save conflictNotice (a real trial-merge conflict; nothing to answer); saved-path windows exclude unsaved peer edits and never prove independence. Hosted `peers {laneId,path?,detail?}` reads the same saved overlap evidence in one query and `diff {laneId,paths?}` compares the pinned base to the saved head (MCP `forge_review`); show {channel:"main",path} or show {laneId,path} reads exact accepted or saved bytes. Announce paths and resolve overlap early.',
  BOARD_LINE,
  // Item 12fde646 (owner decision 2026-11-15): questions stay in the agent's own app.
  'Forge is not a chat channel: ask the person running you in your own app; message through Forge only someone else who must decide (an owner approval, a real choice between options, a handoff to another Lane’s owner).',
  'Governance: hosted landing checks and lands under current project policy. Automatic projects land after passing evidence; protected paths or review-required policy may hold for a person. Never change policy to bypass a hold.',
  // Default project rules (docs/parallel-work-defaults.md); a project's `policy` read shows its own.
  ...agentDefaultLines(AGENT_DEFAULTS),
  'Find public projects by name with `nforge clone NAME` or `forge_find_project` in `nforge mcp --public`. A lookup returns public URLs and clone commands.',
  'Sign in with nforge login before cloning or downloading any Forge project, including public projects. Public web viewing remains open. Use a project’s GitHub mirror for anonymous cloning when available.',
];

// The public page's "Give this to your agent" prompt sends agents here and asks them to explain before acting
// (web/index.html, tests/landing-page.test.mjs). Keep both in step: no install, sign-in or import before the person says so.
export const sentHere =
  'If a person sent you here with the prompt from the Forge public page, explain before you act. Tell them, in a few plain lines: what Forge would change about how they and their agents land work in this repository; what it could cost or save in CI minutes against their current flow, quoting the measured results below as one published benchmark on one repository, not a promise; and what you need from them to try it on one small change. Do not install, sign in, import a repository or change any file until they say so.\n\n' +
  'Forge is in open development. It is not published to npm and there is no public production service yet, so nothing is charged (the public page shows the prices planned for launch); trying it today means building from source ([quickstart](/docs/quickstart.md)). Current state: [status](/docs/status.md).';

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
  'docs/parallel-work-defaults.md',
]);

const referenceDocs = new Set([
  'docs/workflows.md',
  'docs/security.md',
  'docs/architecture.md',
  'docs/development.md',
  'docs/operations.md',
  'docs/operations/self-hosted-runner.md',
  'docs/operations/runner-fallback.md',
  'docs/operations/github-actions-checks.md',
  'docs/readable-urls.md',
]);

export function llmsFullSizeReport(text) {
  const size = Buffer.byteLength(text);
  const percent = ((size / llmsFullWarnBytes) * 100).toFixed(1);
  const head = `llms-full.txt: ${size} bytes (${percent}% of the ${llmsFullWarnBytes} byte warning line).`;
  const warning =
    size > llmsFullWarnBytes
      ? `WARNING: llms-full.txt is ${size - llmsFullWarnBytes} bytes over the warning line; trim llmsFullPaths or shorten a guide soon. The build still passes.`
      : '';
  return { size, warn: size > llmsFullWarnBytes, message: warning ? `${head}\n${warning}` : head };
}

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
  const documents = packageDocuments.map(path => describe(path, readDocument(root, path)));
  const known = new Set(packageDocuments);
  const full = llmsFullPaths.map(path => {
    if (path.startsWith('docs/') && !known.has(path))
      throw new Error(`llms-full source is not in packageDocuments: ${path}`);
    return describe(path, readDocument(root, path));
  });
  const measuredSource = full.find(doc => doc.path === 'docs/why-forge.md').source;
  const measured = /<!-- agent-measurements:start -->\n([\s\S]*?)\n<!-- agent-measurements:end -->/.exec(
    measuredSource,
  )?.[1];
  if (!measured) throw new Error('Why Forge is missing the shared agent measurements block.');
  const skill = readFileSync(join(root, 'skills/forge-agent/SKILL.md'), 'utf8');
  if (!skill.includes(`<!-- agent-workflow:start -->\n${workflow}\n<!-- agent-workflow:end -->`))
    throw new Error('Regenerate the forge-agent workflow block from the CLI verb contract.');
  if (!skill.includes(`<!-- agent-measurements:start -->\n${measured}\n<!-- agent-measurements:end -->`))
    throw new Error('Copy the current Why Forge measurement block to forge-agent before building.');

  const links = selected => selected.map(doc => `- [${doc.title}](/${doc.path}): ${doc.note}`).join('\n');
  const summary =
    'Forge is a source host and workspace for people and AI agents changing the same code at the same time. Isolated Lanes, recorded checks and accepted Channels coordinate concurrent work.';
  const introduction = `# NanthAi:Forge\n\n> ${summary}\n\n`;
  const reference = documents.filter(doc => referenceDocs.has(doc.path));
  const rest = documents.filter(
    doc => !startHere.has(doc.path) && !agentDocs.has(doc.path) && !referenceDocs.has(doc.path),
  );
  const llms =
    `${introduction}## If someone sent you here\n\n${sentHere}\n\n## Documentation site\n\n- [Documentation](/docs/): Static, readable guides for people and agents.\n- [Generated CLI reference](/docs/reference/cli.md): Every hosted command and its enforced JSON schema.\n- [Generated MCP reference](/docs/reference/mcp.md): Hosted tool names and enforced input schemas.\n\n## Start here\n\n${links(documents.filter(doc => startHere.has(doc.path)))}\n` +
    `- [README](${repository}/README.md): ${describe('README.md', full[0].source).note}\n\n` +
    `## For agents\n\n${agentRules.map(rule => `- ${rule}`).join('\n')}\n\n` +
    `${links(documents.filter(doc => agentDocs.has(doc.path)))}\n` +
    `- [forge-agent skill](${repository}/skills/forge-agent/SKILL.md): ${describe('skills/forge-agent/SKILL.md', skill).note}\n\n` +
    `## Measured results\n\n${measured}\n\nMethod, sources and caveats: [Why Forge](/docs/why-forge.md).\n\n` +
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
  return [
    { fileName: 'llms.txt', source: llms },
    { fileName: 'llms-full.txt', source: text },
    ...documents.map(doc => ({ fileName: doc.path, source: doc.source })),
    ...packageDocumentData.map(path => ({ fileName: path, source: readFileSync(join(root, path), 'utf8') })),
  ];
}
