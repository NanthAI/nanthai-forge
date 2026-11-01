// B1.5d contamination audit (B1): a task is void when its agent reached for the answer —
// upstream PRs, the reference/oracle material, earlier cells' landings — or was shown it.
// Rules are pre-registered in PLAN.md; every hit is kept with an excerpt for the report.
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Rules on actions (tool inputs). `prNumbers` are every task's upstream PR numbers;
 * `ownPrs` the fork PRs this agent opened (any other fork PR is an earlier cell's answer);
 * `mergeShas` every task's upstream merge commit (a solution ref, matched from 7 hex
 * characters). */
export function actionRules(prNumbers, ownPrs = [], mergeShas = []) {
  const own = new Set(ownPrs.map(String));
  const shas = mergeShas.filter(Boolean).map(s => s.toLowerCase());
  const hexRuns = s => s.toLowerCase().match(/\b[0-9a-f]{7,40}\b/g) ?? [];
  const prRef = /\bgh\s+pr\s+(?:view|diff|checkout|checks|comment|merge)\s+#?(\d+)|\bpull\/(\d+)/g;
  const prs = new RegExp(`\\b(${prNumbers.join('|')})\\b`);
  return [
    { id: 'upstream', re: /pingdotgg|github\.com\/[^/\s]+\/t3code\/pull/i },
    {
      id: 'solution-or-oracle-ref',
      re: /\bq\/(\d+-(ref|tests)|all-upto|base)\b|\boracle\/|oracle\.sh|\.bench\/oracle/,
    },
    { id: 'bench-data', re: /forge-bench|forge-cache|forge-b15d-oracle|tasks\.json/ },
    {
      id: 'other-prs',
      re: /\bgh\s+(pr|search)\b[^\n]*(--state[= ]+(merged|closed|all)|\bsearch\b)|\bgh\s+search\b/,
    },
    { id: 'git-history-all', re: /\bgit\s+(log|fetch|rev-list|show-ref)\b[^\n]*--all\b|\bgit\s+ls-remote\b/ },
    {
      id: 'github-history-api',
      re: /\bgh\s+api\b[^\n]*(\/pulls\b(?!\/\d)|\/compare|\/events|\/git\/refs|\/branches)/,
    },
    { id: 'task-pr-number', test: s => /\b(gh|git|curl|wget)\b/.test(s) && prs.test(s) },
    { id: 'other-fork-pr', test: s => [...s.matchAll(prRef)].some(m => !own.has(m[1] ?? m[2])) },
    { id: 'solution-merge-sha', test: s => hexRuns(s).some(h => shas.some(sha => sha.startsWith(h))) },
  ];
}

/** Rules on what the agent saw (tool results): leaked refs arriving in its workspace. */
const SEEN = [
  { id: 'saw-solution-branch', re: /\[new branch\][^\n]*\b(q\/|oracle\/)/ },
  { id: 'saw-oracle', re: /\boracle\/[a-z0-9-]+\b[^\n]*->/ },
];

/** Forge: nforge reads of history or of other Lanes/operations (earlier cells' landings). */
function forgeCallHits(calls, ownIds) {
  const hits = [];
  for (const call of calls) {
    const verb = call.verb ?? '';
    const body = (call.args ?? []).join(' ');
    if (/\b(history|export|receipts|planning)\b/.test(verb))
      hits.push({ id: 'forge-history-verb', excerpt: `${verb} ${body}`.slice(0, 200) });
    const foreign = [...body.matchAll(UUID)].map(m => m[0]).filter(id => !ownIds.has(id));
    if (foreign.length && !/\b(ack|overlap-acks)\b/.test(verb))
      hits.push({ id: 'forge-foreign-id', excerpt: `${verb} ${foreign.join(',')}`.slice(0, 200) });
  }
  return hits;
}

/** Scan one task. session = readSession(prefix); calls = this task's relay calls (Forge). */
export function scanTask({
  session,
  calls = [],
  ownIds = new Set(),
  prNumbers,
  ownPrs = [],
  mergeShas = [],
  workspace = null,
}) {
  const hits = [];
  const rules = actionRules(prNumbers, ownPrs, mergeShas);
  // Workspaces sit under the bench root: the agent's own absolute paths (Codex patches use
  // them) are not bench data; any other path under the bench root still is.
  const own = input => (workspace ? input.split(workspace).join('<workspace>') : input);
  for (const { tool, input: raw } of session.actions)
    for (const rule of rules) {
      const input = own(raw);
      const hit = rule.test ? rule.test(input) : rule.re.test(input);
      if (hit) hits.push({ id: rule.id, tool, excerpt: input.slice(0, 200) });
    }
  for (const raw of session.seen)
    for (const rule of SEEN) {
      const m = own(raw).match(rule.re);
      if (m) hits.push({ id: rule.id, excerpt: m[0].slice(0, 200) });
    }
  // Ids the agent legitimately knows: its Lane and every operation its own calls returned.
  for (const call of calls)
    for (const id of [...(call.operationIds ?? []), ...(call.ids ?? [])]) ownIds.add(id);
  hits.push(...forgeCallHits(calls, ownIds));
  return { source: session.source, void: hits.length > 0, hits };
}
