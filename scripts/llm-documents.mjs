// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageDocuments } from './package-documents.mjs';

// This explicit inventory is already public and packaged, including status/backlog/roadmap.
// Never scan the workspace: unlisted docs, private output and vendor notice trees stay out.
export function llmDocuments(root) {
  const documents = packageDocuments.map(path => {
    const source = readFileSync(join(root, path), 'utf8');
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
  });
  const introductory = new Set([
    'docs/README.md',
    'docs/why-forge.md',
    'docs/principles.md',
    'docs/agents/improvement-loop.md',
    'docs/quickstart.md',
    'docs/concepts.md',
    'docs/agents/workflow.md',
  ]);
  const links = selected => selected.map(doc => `- [${doc.title}](/${doc.path}): ${doc.note}`).join('\n');
  const introduction =
    '# NanthAi:Forge\n\n> Forge is a source host and workspace for people and AI agents changing the same code at the same time. Isolated Lanes, recorded checks and accepted Channels coordinate concurrent work.\n\n';
  const llms = `${introduction}## Start here\n\n${links(documents.filter(doc => introductory.has(doc.path)))}\n\n## Documentation\n\n${links(documents.filter(doc => !introductory.has(doc.path)))}\n\n## Full text\n\n- [Complete public documentation](/llms-full.txt): Every packaged Markdown document, in inventory order, including public status, backlog and roadmap.\n`;
  const full = `${introduction}Every document in the public packaged inventory follows in stable inventory order, including status, backlog and roadmap. Unlisted documents, vendor notice trees, root files and agent skills are excluded.\n\n${documents.map(doc => `---\n\nSource: /${doc.path}\n\n${doc.source}`).join('\n\n')}`;
  return [
    { fileName: 'llms.txt', source: llms },
    { fileName: 'llms-full.txt', source: full },
    ...documents.map(doc => ({ fileName: doc.path, source: doc.source })),
  ];
}
