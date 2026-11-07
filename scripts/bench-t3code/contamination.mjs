// SPDX-License-Identifier: Apache-2.0
// B1.5d contamination audit (B1): a task is void when its agent reached for the answer —
// upstream PRs, the reference/oracle material, earlier cells' landings — or was shown it.
// Rules are pre-registered in PLAN.md; every hit is kept with an excerpt for the report.
import { commandText, shellCommands } from './command-text.mjs';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

// ---- Reading what an action does -------------------------------------------------------
// Tool inputs arrive as raw shell text, JSON or Codex code-mode JavaScript; command-text.mjs
// turns each into the commands it runs (quotes resolved, heredoc bodies kept with their
// command), so a rule can tell a read of upstream from a mention of it in a PR body.
export { commandText, shellCommands };

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Replace each of the given absolute paths (and anything below them) by a placeholder. */
function maskPaths(input, paths, placeholder) {
  let out = input;
  for (const path of paths.filter(Boolean))
    out = out.replace(new RegExp(`${escapeRe(path.replace(/\/+$/, ''))}(?![\\w.-])`, 'g'), placeholder);
  return out;
}

const OWN_PLACEHOLDER = /^\{owner\}\/\{repo\}$/;
const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** `gh api` of a command: { endpoint, write } (first positional word after `api`, flag values
 * skipped; `write` when the call changes something: POST/PATCH/PUT/DELETE, or fields given
 * without an explicit GET, which gh sends as POST). */
function ghApi(cmd) {
  const w = cmd.words;
  const at = w.findIndex((x, i) => x === 'gh' && w[i + 1] === 'api');
  if (at < 0) return null;
  const takesValue = new Set([
    '-H',
    '--header',
    '-q',
    '--jq',
    '-t',
    '--template',
    '--hostname',
    '--cache',
    '-p',
    '--preview',
  ]);
  const fieldFlag = /^(-f|-F|--raw-field|--field|--input)(=|$)|^-[fF]./;
  let endpoint = null;
  let method = null;
  let fields = false;
  for (let i = at + 2; i < w.length; i++) {
    const x = w[i];
    if (x === '-X' || x === '--method') method = w[++i];
    else if (/^--method=/.test(x)) method = x.slice(9);
    else if (/^-X./.test(x)) method = x.slice(2);
    else if (fieldFlag.test(x)) {
      fields = true;
      if (/^(-f|-F|--raw-field|--field|--input)$/.test(x)) i++;
    } else if (takesValue.has(x)) i++;
    else if (!x.startsWith('-') && endpoint === null) endpoint = x.replace(/^\/+/, '').split('?')[0];
  }
  const verb = (method ?? (fields ? 'POST' : 'GET')).toUpperCase();
  return { endpoint, write: WRITE_METHODS.has(verb) };
}

/** Does a `gh api` call read this repo's PR/branch/ref history beyond what the agent owns?
 * `ctx.ownRepo` is the agent's own fork; `own` the PR numbers it opened. Only the agent's own
 * fork is exempt: its own PRs, its branch list/protection and rules, refs of named branches,
 * and any write (creating its own PR or branch is no read of history); everything else keeps
 * the pre-registered meaning. */
function ghApiHistoryHit(cmd, { ownRepo, own }) {
  const api = ghApi(cmd);
  if (api === null || api.endpoint === null) return false;
  const { endpoint, write } = api;
  const m = /^repos\/([^/]+\/[^/]+)\/(.*)$/.exec(endpoint);
  if (!m)
    return /\/(pulls\b(?!\/\d)|compare|events|git\/refs|branches)/.test(
      cmd.text.replace(/^.*?gh\s+api\b/, ''),
    );
  const [, repo, rest] = m;
  const mine = OWN_PLACEHOLDER.test(repo) || (ownRepo && repo.toLowerCase() === ownRepo.toLowerCase());
  if (write && mine) return false;
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
function lsRemoteHit(cmd, { ownBranches, ownRepo }) {
  const w = cmd.words;
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
  /^(gh|git|curl|wget|hub|http|xh|node|nodejs|python3?(\.\d+)?|ruby|perl|php|deno|bun|tsx|npx|npm|pnpm|yarn)$/;
const writerVerbs = w =>
  (w[0] === 'gh' && /^(pr|issue)$/.test(w[1]) && /^(create|edit|comment|review)$/.test(w[2])) ||
  (w[0] === 'git' && /^(commit|tag)$/.test(w[1]));
/** `-R pingdotgg/…` / `--repo=pingdotgg/…` aimed at upstream. */
const repoFlagUpstream = w =>
  w.some((x, i) => /^(-R|--repo)$/.test(x) && /pingdotgg/i.test(w[i + 1] ?? '')) ||
  w.some(x => /^(--repo=|-R)\S*pingdotgg/i.test(x));

const INTERPRETERS = /^(node|nodejs|python3?(\.\d+)?|ruby|perl|php|deno|bun|tsx)$/;
// What lets a script reach the network or run gh/git/curl: an HTTP client, a subprocess call.
const FETCH_CAPABLE = new RegExp(
  [
    String.raw`\b(urllib|urlopen|requests|httpx|aiohttp|http\.client|httplib|socket|subprocess|pexpect)\b`,
    String.raw`\bos\.(system|popen)\b|\bfetch\s*\(|\b(axios|undici|node-fetch|child_process)\b`,
    String.raw`\bhttps?\.(get|request)\b|require\(\s*['"](node:)?https?['"]|from\s+['"](node:)?https?['"]`,
    String.raw`\b(execSync|spawnSync|execFile|spawn|exec)\s*\(|\bNet::HTTP\b|\bopen-uri\b|\bURI\.open\b`,
    String.raw`\bLWP\b|\bHTTP::|\bsystem\s*\(|\bcurl\b|\bwget\b|\bgh\s+(api|pr|issue|search|repo)\b`,
    String.raw`\bgit\s+(fetch|clone|ls-remote|remote|pull|show|log|diff)\b`,
  ].join('|'),
);
/** An interpreter run against upstream: the target named as an argument, or a script (inline
 * `-c`/`-e` code or a heredoc body) that names upstream and can reach the network. A script
 * that only writes text mentioning upstream (a PR body file) is a mention. */
function interpreterHit(cmd) {
  const w = cmd.words;
  const flag = w.findIndex((x, i) => i > 0 && /^(-c|-e|-p|-E|-pe|-ne|--eval|--print)$/.test(x));
  const code = [cmd.body, flag > 0 ? (w[flag + 1] ?? '') : ''].filter(Boolean).join('\n');
  const args = w.filter((x, i) => !(flag > 0 && i === flag + 1)).join(' ');
  return UPSTREAM.test(args) || (UPSTREAM.test(code) && FETCH_CAPABLE.test(code));
}

/** A read or fetch against upstream (gh/curl/git on pingdotgg, or any web tool call), not a
 * mention of it in text the agent writes. A heredoc body fed to an interpreter is part of its
 * command (python3 - <<EOF … EOF). */
function upstreamHit(input, tool) {
  if (/^(WebFetch|WebSearch)$/i.test(String(tool ?? ''))) return UPSTREAM.test(input);
  for (const cmd of shellCommands(commandText(input, tool))) {
    const head = cmd.words[0].replace(/^.*\//, '');
    if (!FETCHERS.test(head)) continue;
    if (INTERPRETERS.test(head)) {
      if (interpreterHit(cmd)) return true;
      continue;
    }
    const api = ghApi(cmd);
    if (writerVerbs(cmd.words) || api?.write) {
      // Text the agent writes (PR/issue/commit bodies, fields of an API write) is a mention;
      // aiming the command itself at upstream is not.
      if (repoFlagUpstream(cmd.words) || (api?.write && UPSTREAM.test(api.endpoint ?? ''))) return true;
      continue;
    }
    if (UPSTREAM.test(cmd.text)) return true;
  }
  return false;
}

// Bench data: anything under the bench root that is not the agent's own workspace and tools.
const BENCH_PATH = /forge-bench|forge-cache|forge-b15d-oracle|tasks\.json/;
const BENCH_REF =
  /[^\s"'`;|&<>()=,{}\\]*(?:forge-bench|forge-cache|forge-b15d-oracle|tasks\.json)[^\s"'`;|&<>()=,{}\\]*/g;
const LISTERS = /^(ls|tree|exa|eza|lsd|dir)$/;
const LIST_ERROR = /Operation not permitted|Permission denied|No such file or directory|cannot access/i;

/** The bench references of a command text: `direct` for any specific path (another cell, runs,
 * tasks.json, the oracle) and `root` when the command only names the bench root itself, to
 * list or search it. `benchRoot` is the absolute root of this bench (null: every reference is
 * direct). */
function benchRefs(text, benchRoot) {
  const forms = [];
  if (benchRoot) {
    const parts = benchRoot.replace(/\/+$/, '').split('/');
    forms.push(parts.join('/'), parts.slice(0, -1).join('/'), parts.slice(-2).join('/'), parts.at(-2));
  }
  let direct = false;
  let root = false;
  for (const [token] of text.matchAll(BENCH_REF)) {
    const t = token
      .replace(/[:.,]+$/, '')
      .replace(/\/+(\*\*?|\.)?$/, '')
      .replace(/\/+$/, '');
    if (!BENCH_PATH.test(t) || /forge-cache|forge-b15d-oracle|tasks\.json/.test(t)) direct = true;
    else if (forms.some(f => f && (t === f || t.endsWith(`/${f}`)))) root = true;
    else direct = true;
  }
  return { direct, root };
}

/** Rules on actions (tool inputs). `prNumbers` are every task's upstream PR numbers;
 * `ownPrs` the fork PRs this agent opened (any other fork PR is an earlier cell's answer);
 * `mergeShas` every task's upstream merge commit (a solution ref, matched from 7 hex
 * characters). Each rule is one of: `re`/`text` (a regex / predicate on the raw input or the
 * decoded command text), `commands` (a predicate on the simple commands the action runs) or
 * `test(raw, decoded, action)` (needs the whole action, e.g. what its tool returned). */
export function actionRules(prNumbers, ownPrs = [], mergeShas = [], ctx = {}) {
  const own = new Set(ownPrs.map(String));
  const { ownRepo = null, ownBranches = [], benchRoot = null } = ctx;
  const shas = mergeShas.filter(Boolean).map(s => s.toLowerCase());
  const hexRuns = s => s.toLowerCase().match(/\b[0-9a-f]{7,40}\b/g) ?? [];
  const prRef = /\bgh\s+pr\s+(?:view|diff|checkout|checks|comment|merge)\s+#?(\d+)|\bpull\/(\d+)/g;
  const prs = new RegExp(`\\b(${prNumbers.join('|')})\\b`);
  return [
    { id: 'upstream', test: (raw, decoded, { tool }) => upstreamHit(raw, tool) },
    {
      id: 'solution-or-oracle-ref',
      re: /\bq\/(\d+-(ref|tests)|all-upto|base)\b|\boracle\/|oracle\.sh|\.bench\/oracle/,
    },
    {
      id: 'bench-data',
      // A specific path is a reach for bench data. A search or listing of the bench root
      // itself is judged by its outcome: it is a hit only when the tool result shows a bench
      // path outside the agent's own workspace and tools, or listed entries of the root.
      test: (raw, decoded, { result, tool }) => {
        const refs = [raw, decoded].map(t => benchRefs(t, benchRoot));
        if (refs.some(r => r.direct)) return true;
        if (!refs.some(r => r.root)) return false;
        if (result === undefined) return true; // outcome unknown: keep the command's meaning
        if (benchRefs(result, benchRoot).direct) return true; // the root itself (an error line) shows nothing
        const lists = shellCommands(commandText(raw, tool)).some(c =>
          LISTERS.test(c.words[0].replace(/^.*\//, '')),
        );
        return lists && !LIST_ERROR.test(result) && /\w/.test(result);
      },
    },
    {
      id: 'other-prs',
      re: /\bgh\s+(pr|search)\b[^\n]*(--state[= ]+(merged|closed|all)|\bsearch\b)|\bgh\s+search\b/,
    },
    {
      id: 'git-history-all',
      text: s => /\bgit\s+(log|fetch|rev-list|show-ref)\b[^\n]*--all\b/.test(s),
      commands: cmds => cmds.some(cmd => lsRemoteHit(cmd, { ownBranches, ownRepo })),
    },
    { id: 'github-history-api', commands: cmds => cmds.some(cmd => ghApiHistoryHit(cmd, { ownRepo, own })) },
    { id: 'task-pr-number', text: s => /\b(gh|git|curl|wget)\b/.test(s) && prs.test(s) },
    { id: 'other-fork-pr', text: s => [...s.matchAll(prRef)].some(m => !own.has(m[1] ?? m[2])) },
    { id: 'solution-merge-sha', text: s => hexRuns(s).some(h => shas.some(sha => sha.startsWith(h))) },
  ];
}

/** Does this rule fire on the action? `raw` is the input as the agent sent it, `decoded` the
 * command text read from it (the two are equal for plain shell text). */
function ruleHit(rule, raw, decoded, action) {
  if (rule.test) return rule.test(raw, decoded, action);
  const texts = raw === decoded ? [raw] : [raw, decoded];
  if (rule.re && texts.some(t => rule.re.test(t))) return true;
  if (rule.text && texts.some(t => rule.text(t))) return true;
  return Boolean(rule.commands) && rule.commands(shellCommands(decoded));
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
  benchRoot = null,
}) {
  const hits = [];
  const rules = actionRules(prNumbers, ownPrs, mergeShas, { ownRepo, ownBranches, benchRoot });
  // Workspaces sit under the bench root: the agent's own absolute paths (Codex patches use
  // them) are not bench data; any other path under the bench root still is. Neither are the
  // tools the harness gave this agent: its cell's bin/ (nforge), vp/ and hub/, and the shared
  // deps toolchain cache (`toolPaths`).
  const own = input =>
    maskPaths(workspace ? input.split(workspace).join('__workspace__') : input, toolPaths, '__bench-tool__');
  for (const action of session.actions) {
    const raw = own(String(action.input));
    const decoded = commandText(raw, action.tool);
    const seenAs = {
      tool: action.tool,
      result: action.result === undefined ? undefined : own(action.result),
    };
    for (const rule of rules)
      if (ruleHit(rule, raw, decoded, seenAs))
        hits.push({ id: rule.id, tool: action.tool, excerpt: raw.slice(0, 200) });
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
