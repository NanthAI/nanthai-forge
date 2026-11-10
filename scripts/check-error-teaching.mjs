// SPDX-License-Identifier: Apache-2.0
// Errors that teach (Issue 0a7d6f56): every public error code (the growth guard's count) must resolve to a
// help topic, and every `next` template and help topic may name only commands, actions and topics that
// exist. Static: reads source text and the two pure data modules; runs no project code, no Convex call.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { agentActionNames, cliCommandNames, errorCodes } from './check-growth.mjs';

const skip = new Set(['_generated', 'node_modules']);
function sources(dir, root) {
  const base = resolve(root, dir);
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true }).flatMap(entry => {
    if (skip.has(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path, root);
    return /\.(?:ts|mts)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
  });
}

/** A command an error or topic names: `nforge agent|x ROOT ACTION …` or `nforge COMMAND …`. */
export function commandFindings(command, where, known) {
  const words = command.trim().split(/\s+/);
  if (words[0] !== 'nforge')
    return [`${where}: next must be one nforge command or <replay>, got "${command}"`];
  if (words[1] === 'agent' || words[1] === 'x') {
    const action = words[3];
    if (!action) return [`${where}: "${command}" names no action after ROOT`];
    if (known.actions.has(action)) return [];
    return [`${where}: "${command}" names action ${action}, which does not exist`];
  }
  return known.commands.has(words[1])
    ? []
    : [`${where}: "${command}" names command ${words[1]}, which does not exist`];
}

export async function errorTeachingFindings(root) {
  const read = path => readFileSync(resolve(root, path), 'utf8');
  const { teachingByCode, teachingFamilies, teachingEntry } = await import(
    resolve(root, 'src/error-teaching.ts')
  );
  const { helpTopics, HELP_TOPIC_MAX } = await import(resolve(root, 'src/help-topics.ts'));
  // Hosted client reads (lanes, queue, wait, …) dispatch outside the agent verbs.
  const reads = read('src/hosted-agent-reads.ts');
  const readBlock = reads.slice(reads.indexOf('export const hostedClientReadSchemas = {'));
  const clientReads = [
    ...readBlock.slice(0, readBlock.indexOf('} as const')).matchAll(/^\s*'?([a-z][\w-]*)'?:/gm),
  ];
  const known = {
    actions: new Set([
      ...agentActionNames(read('src/agent-verbs.ts')),
      ...clientReads.map(m => m[1]),
      'help',
    ]),
    commands: cliCommandNames(read('src/cli.ts')),
  };
  const topics = new Set(Object.keys(helpTopics));
  const codes = new Set(
    ['src', 'netlify', 'convex'].flatMap(dir => sources(dir, root)).flatMap(path => errorCodes(read(path))),
  );
  const findings = [];
  const untaught = [...codes].filter(code => !teachingEntry(code)).sort();
  if (untaught.length)
    findings.push(
      `src/error-teaching.ts: public error code(s) with no learn topic: ${untaught.join(', ')}. Add each to teachingByCode (with next when one command is the fix) or to a family.`,
    );
  for (const [code, entry] of Object.entries(teachingByCode)) {
    const where = `src/error-teaching.ts ${code}`;
    if (!codes.has(code)) findings.push(`${where}: no public error code ${code} exists; remove the entry`);
    if (!topics.has(entry.learn))
      findings.push(`${where}: learn names topic ${entry.learn}, which does not exist`);
    // <replay> and <command> are the caller's own command; anything else must exist.
    if (entry.next && entry.next !== '<replay>' && !entry.next.startsWith('<command> '))
      findings.push(...commandFindings(entry.next, where, known));
  }
  for (const [, topic] of teachingFamilies)
    if (!topics.has(topic))
      findings.push(`src/error-teaching.ts: a family names topic ${topic}, which does not exist`);
  for (const [id, topic] of Object.entries(helpTopics)) {
    const where = `src/help-topics.ts ${id}`;
    const length = `${topic.title}\n${topic.text}`.length;
    if (length > HELP_TOPIC_MAX) findings.push(`${where}: ${length} characters, over ${HELP_TOPIC_MAX}`);
    for (const [, name] of topic.text.matchAll(/(?:(?:ROOT|\.) |More: |, )help ([a-z][a-z-]*)/g))
      if (!topics.has(name)) findings.push(`${where}: names help topic ${name}, which does not exist`);
    for (const [command] of topic.text.matchAll(
      /\bnforge (?:(?:agent|x) (?:ROOT|\.) [a-z][\w-]*|(?!agent\b|x\b)[a-z][\w-]*)/g,
    ))
      findings.push(...commandFindings(command, where, known));
  }
  return findings;
}
