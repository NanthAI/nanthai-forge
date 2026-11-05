// B1.5d contamination audit (B1): a task is void when its agent reached for the answer —
// upstream PRs, the reference/oracle material, earlier cells' landings — or was shown it.
// Rules are pre-registered in PLAN.md; every hit is kept with an excerpt for the report.
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

// ---- Reading what an action does -------------------------------------------------------
// Tool inputs arrive as raw shell text (scripted agents, Codex) or as JSON (Claude Bash, Codex
// function calls). `commandText` turns both into plain text with real line breaks, and
// `segments` splits it into simple commands, so a rule can tell a read of upstream from a
// mention of it in a PR body or commit message.

/** The text an input carries: JSON string values (arrays joined by spaces) one per line, or
 * the raw text when it is not JSON. */
export function commandText(input) {
  const text = String(input);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (parsed === null || typeof parsed !== 'object') return text;
  const out = [];
  (function walk(v) {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v) && v.every(x => typeof x === 'string')) out.push(v.join(' '));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  })(parsed);
  return out.join('\n');
}

/** Simple commands of a shell text, leading wrappers (env assignments, `bash -lc`, sudo) off. */
export function segments(text) {
  return text
    .split(/\r?\n|;|&&|\|\||\||&(?!>)/)
    .map(part =>
      part
        .trim()
        .replace(/^(?:(?:\w+=\S*|sudo|env|command|time|exec|(?:ba|z)?sh\s+-\w*c)\s+)+/, '')
        .replace(/^["'`(]+/, ''),
    )
    .filter(Boolean);
}

/** Shell-ish words of one segment (quotes removed; not a full parser). */
const words = segment => [...segment.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3]);

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Replace each of the given absolute paths (and anything below them) by a placeholder. */
function maskPaths(input, paths, placeholder) {
  let out = input;
  for (const path of paths.filter(Boolean))
    out = out.replace(new RegExp(`${escapeRe(path.replace(/\/+$/, ''))}(?![\\w.-])`, 'g'), placeholder);
  return out;
}

const OWN_PLACEHOLDER = /^\{owner\}\/\{repo\}$/;

/** `gh api` endpoints of a segment (first positional word after `api`, flag values skipped). */
function ghApiEndpoint(segment) {
  const w = words(segment);
  const at = w.findIndex((x, i) => x === 'gh' && w[i + 1] === 'api');
  if (at < 0) return null;
  const takesValue = new Set([
    '-X',
    '--method',
    '-H',
    '--header',
    '-f',
    '--raw-field',
    '-F',
    '--field',
    '-q',
    '--jq',
    '-t',
    '--template',
    '--input',
    '--hostname',
    '--cache',
    '-p',
    '--preview',
  ]);
  for (let i = at + 2; i < w.length; i++) {
    if (takesValue.has(w[i])) i++;
    else if (!w[i].startsWith('-')) return w[i].replace(/^\/+/, '').split('?')[0];
  }
  return null;
}

/** Does a `gh api` call read this repo's PR/branch/ref history beyond what the agent owns?
 * `ctx.ownRepo` is the agent's own fork; `own` the PR numbers it opened. Only the agent's own
 * fork is exempt, and only for its own PRs, its branch list/protection and rules, and refs of
 * named branches; everything else keeps the pre-registered meaning. */
function ghApiHistoryHit(segment, { ownRepo, own }) {
  const endpoint = ghApiEndpoint(segment);
  if (endpoint === null) return false;
  const m = /^repos\/([^/]+\/[^/]+)\/(.*)$/.exec(endpoint);
  if (!m)
    return /\/(pulls\b(?!\/\d)|compare|events|git\/refs|branches)/.test(
      segment.replace(/^.*?gh\s+api\b/, ''),
    );
  const [, repo, rest] = m;
  const mine = OWN_PLACEHOLDER.test(repo) || (ownRepo && repo.toLowerCase() === ownRepo.toLowerCase());
  if (/(^|\/)compare(\/|$)/.test(rest)) return true;
  if (/(^|\/)events\b/.test(rest)) {
    const issueEvents = /^issues\/([^/]+)\/events\b/.exec(rest);
    return !(issueEvents && mine && own.has(issueEvents[1]));
  }
  // The list of PRs (and pulls/comments etc.) shows earlier cells' work; pulls/<n> is not hit.
  if (/^pulls(\/(?!\d).*)?$/.test(rest)) return true;
  if (/^git\/(matching-refs|refs?)\b/.test(rest)) {
    const named = /^git\/refs?\/heads\/[^/]+/.test(rest);
    return !(mine && named);
  }
  if (/^branches\/?$/.test(rest)) return !mine; // the branch list of any repo but its own fork
  return false;
}

/** `git ls-remote` of anything but the agent's own branches or main. */
function lsRemoteHit(segment, { ownBranches, ownRepo }) {
  const w = words(segment);
  const at = w.findIndex((x, i) => x === 'git' && w[i + 1] === 'ls-remote');
  if (at < 0) return false;
  const args = [];
  for (let i = at + 2; i < w.length; i++) {
    if (['-o', '--server-option', '--upload-pack', '--sort'].includes(w[i])) i++;
    else if (!w[i].startsWith('-')) args.push(w[i]);
  }
  const [remote, ...patterns] = args;
  if (!remote || !(remote === 'origin' || (ownRepo && remote.toLowerCase().includes(ownRepo.toLowerCase()))))
    return true;
  if (!patterns.length) return true; // every ref of the remote
  const allowed = new Set(['main', ...ownBranches]);
  return !patterns.every(p => {
    const name = p.replace(/^refs\/heads\//, '');
    return allowed.has(name) || /^gh-readonly-queue\/main\//.test(name);
  });
}

const UPSTREAM = /pingdotgg|github\.com\/[^/\s]+\/t3code\/pull/i;
// Commands that can reach upstream; `cat`, `grep` and friends only search the checkout.
const FETCHERS =
  /^(gh|git|curl|wget|hub|http|xh|node|nodejs|python3?|ruby|perl|deno|bun|npx|npm|pnpm|yarn)\b/;
/** gh/git verbs that write a PR, issue or commit message: a link in their text is a mention. */
const WRITERS = /^(gh\s+(pr|issue)\s+(create|edit|comment|review)\b|git\s+(commit|tag)\b)/;

/** A read or fetch against upstream (gh/curl/git on pingdotgg, or any web tool call), not a
 * mention of it in text the agent writes. */
function upstreamHit(input, tool) {
  if (/^(WebFetch|WebSearch)$/i.test(String(tool ?? ''))) return UPSTREAM.test(input);
  for (const segment of segments(commandText(input))) {
    if (!FETCHERS.test(segment)) continue;
    if (WRITERS.test(segment)) {
      if (/(?:^|\s)(?:-R|--repo)[=\s]+\S*pingdotgg/i.test(segment)) return true;
      continue;
    }
    if (UPSTREAM.test(segment)) return true;
  }
  return false;
}

/** Rules on actions (tool inputs). `prNumbers` are every task's upstream PR numbers;
 * `ownPrs` the fork PRs this agent opened (any other fork PR is an earlier cell's answer);
 * `mergeShas` every task's upstream merge commit (a solution ref, matched from 7 hex
 * characters). */
export function actionRules(prNumbers, ownPrs = [], mergeShas = [], ctx = {}) {
  const own = new Set(ownPrs.map(String));
  const { ownRepo = null, ownBranches = [] } = ctx;
  const shas = mergeShas.filter(Boolean).map(s => s.toLowerCase());
  const hexRuns = s => s.toLowerCase().match(/\b[0-9a-f]{7,40}\b/g) ?? [];
  const prRef = /\bgh\s+pr\s+(?:view|diff|checkout|checks|comment|merge)\s+#?(\d+)|\bpull\/(\d+)/g;
  const prs = new RegExp(`\\b(${prNumbers.join('|')})\\b`);
  return [
    { id: 'upstream', test: (s, tool) => upstreamHit(s, tool) },
    {
      id: 'solution-or-oracle-ref',
      re: /\bq\/(\d+-(ref|tests)|all-upto|base)\b|\boracle\/|oracle\.sh|\.bench\/oracle/,
    },
    { id: 'bench-data', re: /forge-bench|forge-cache|forge-b15d-oracle|tasks\.json/ },
    {
      id: 'other-prs',
      re: /\bgh\s+(pr|search)\b[^\n]*(--state[= ]+(merged|closed|all)|\bsearch\b)|\bgh\s+search\b/,
    },
    {
      id: 'git-history-all',
      test: s =>
        /\bgit\s+(log|fetch|rev-list|show-ref)\b[^\n]*--all\b/.test(s) ||
        segments(commandText(s)).some(seg => lsRemoteHit(seg, { ownBranches, ownRepo })),
    },
    {
      id: 'github-history-api',
      test: s => segments(commandText(s)).some(seg => ghApiHistoryHit(seg, { ownRepo, own })),
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
  ownRepo = null,
  ownBranches = [],
  toolPaths = [],
}) {
  const hits = [];
  const rules = actionRules(prNumbers, ownPrs, mergeShas, { ownRepo, ownBranches });
  // Workspaces sit under the bench root: the agent's own absolute paths (Codex patches use
  // them) are not bench data; any other path under the bench root still is. Neither are the
  // tools the harness gave this agent: its cell's bin/ (nforge) and vp/, and the shared deps
  // toolchain cache (`toolPaths`).
  const own = input =>
    maskPaths(workspace ? input.split(workspace).join('<workspace>') : input, toolPaths, '<bench-tool>');
  for (const { tool, input: raw } of session.actions)
    for (const rule of rules) {
      const input = own(raw);
      const hit = rule.test ? rule.test(input, tool) : rule.re.test(input);
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
