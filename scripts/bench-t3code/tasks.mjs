#!/usr/bin/env node
// B1.5d task set: freeze tasks.json from saved PR metadata (offline, no network).
// Usage: node scripts/bench-t3code/tasks.mjs RAW_DIR OUT.json
// RAW_DIR holds pr-<n>.json (gh pr view: number,title,body,url,mergedAt,merge,author),
// files/<n>.json (changed files) and the base commit. Prompts come from the PR title
// and description only, never the diff; reference/test paths are oracle-only fields.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const base = {
  repository: 'pingdotgg/t3code',
  commit: 'a2f901effb59a81126f4b343b204928f2f87f81f',
  upstreamParent: '52f4ec6f9420abc8f4c033528f95397fd2716f0b',
  commitTitle:
    'LOCAL PROPOSAL: C plus six preview prerequisites and their own tests; harness builder owns bench CI normalization and final pins',
};
// Overlap design (part 3, lead 2026-11-01 12:50): three dispatch groups (plan.mjs
// DESIGN.dispatchGroups) plus same-package and disjoint tasks. The Pi pair touches the same
// files but its references merge clean; the Codex pair and two preview pairs conflict.
export const groups = {
  27514: 'same-file:pi-adapter (reference merge clean)',
  27521: 'same-file:pi-adapter (reference merge clean)',
  19456: 'overlap:preview (source and test-helper pairs)',
  23766: 'overlap:codex-client-tests (same test insertion)',
  26563: 'same-package:shared',
  26770: 'disjoint:source-control-forgejo',
  27069: 'same-package:shared',
  23938: 'overlap:codex-client-tests (same test insertion)',
  22302: 'overlap:preview (source and test-helper pairs)',
  27456: 'overlap:preview (source and test-helper pairs)',
};
const isTest = path => /\.test\.(ts|tsx|mjs|cjs|js)$/.test(path);

/** Title + description, minus images, HTML comments and model/harness attribution. */
export function cleanDescription(body) {
  return body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .split('\n')
    .filter(
      line =>
        !/(via (Codex|Claude Code) in T3 Code|in T3 Code \(Claude Code)/i.test(line) &&
        !/^\s*(🤖 Generated with|Generated with \[Claude Code\]|Claude Opus [\d.]+ in T3 Code|Opus [\d.]+ via Claude Code|Model: |Harness: )/i.test(
          line,
        ),
    )
    .join('\n')
    .replace(/\n-{3,}\s*$/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function buildTasks(raw) {
  const tasks = Object.keys(groups).map(number => {
    const pr = JSON.parse(readFileSync(join(raw, `pr-${number}.json`), 'utf8'));
    const files = JSON.parse(readFileSync(join(raw, 'files', `${number}.json`), 'utf8'));
    const description = cleanDescription(pr.body ?? '');
    return {
      id: `t${number}`,
      pr: Number(number),
      url: pr.url,
      mergedAt: pr.mergedAt,
      mergeCommit: pr.merge,
      overlap: groups[number],
      prompt: `${pr.title}\n\n${description}`,
      oracle: {
        testFiles: files.filter(f => isTest(f.f)).map(f => f.f),
        referenceFiles: files.map(f => f.f),
      },
    };
  });
  tasks.sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
  const body = { base, frozenAt: new Date().toISOString(), tasks };
  return { ...body, sha256: createHash('sha256').update(JSON.stringify(tasks)).digest('hex') };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [raw, out] = process.argv.slice(2);
  writeFileSync(out, JSON.stringify(buildTasks(raw), null, 1) + '\n', { flag: 'wx' });
  console.log(out);
}
